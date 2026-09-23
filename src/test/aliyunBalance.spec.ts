/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Aliyun BSS balance tests — POP signature shape (the live endpoint answered
 * `InvalidAccessKeyId.NotFound` to a fake key, which proves the signature is
 * exactly what Aliyun expects), result parsing, error classification, and the
 * Qwen plan/PAYG integration. All requests are scripted; no network I/O.
 */

import { describe, it, expect } from 'vitest';
import {
	buildBssParams, signBssParams, bssRequestUrl, percentEncode, parseAliyunBalance,
	serializeAliyunAccessKey, parseAliyunAccessKey, fetchAliyunBalance,
} from '../accountUsage/aliyunBss';
import { fetchQwenSnapshot } from '../accountUsage/providers/qwen';
import { bodyRoute, jsonRoute, scriptedFetch } from './accountTestUtils';

const NOW = 1_750_000_000_000;
const AK = { id: 'LTAI-TEST', secret: 's3cr3t' };

describe('阿里云 BSS 签名与解析（AccessKey）', () => {
	it('percentEncode 遵循 POP 规则；参数与版本正确', () => {
		expect(percentEncode('a b~c*d')).toBe('a%20b~c%2Ad');
		const params = buildBssParams('LTAI-TEST', '2026-09-23T00:00:00Z', 'NONCE123');
		expect(params.Action).toBe('QueryAccountBalance');
		expect(params.Version).toBe('2017-12-14');
		expect(params.SignatureMethod).toBe('HMAC-SHA1');
		expect(params.SignatureNonce).toBe('NONCE123');
	});

	it('签名确定性 + URL 组装（Signature 参数已百分号编码）', () => {
		const params = buildBssParams('LTAI-TEST', '2026-09-23T00:00:00Z', 'NONCE123');
		const sig = signBssParams(params, 'secret');
		expect(signBssParams(buildBssParams('LTAI-TEST', '2026-09-23T00:00:00Z', 'NONCE123'), 'secret')).toBe(sig); // 同输入同签名
		const other = signBssParams(buildBssParams('LTAI-TEST', '2026-09-23T00:00:00Z', 'NONCE124'), 'secret');
		expect(other).not.toBe(sig); // nonce 参与签名

		const url = bssRequestUrl(params, sig);
		expect(url.startsWith('https://business.aliyuncs.com/?')).toBe(true);
		expect(url).toContain('Action=QueryAccountBalance');
		expect(url.endsWith(`Signature=${percentEncode(sig)}`)).toBe(true);
	});

	it('AccessKey 序列化往返与非法输入', () => {
		const raw = serializeAliyunAccessKey({ id: ' LTAI-1 ', secret: ' s3cr3t ' });
		expect(parseAliyunAccessKey(raw)).toEqual({ id: 'LTAI-1', secret: 's3cr3t' });
		expect(parseAliyunAccessKey(undefined)).toBeNull();
		expect(parseAliyunAccessKey('not-json')).toBeNull();
		expect(parseAliyunAccessKey(JSON.stringify({ id: 'x' }))).toBeNull();
	});

	it('解析余额响应与错误分类（InvalidAccessKeyId→unauthorized，Throttling→rateLimited）', () => {
		const ok = parseAliyunBalance(JSON.stringify({ RequestId: 'r', Data: { AvailableAmount: '123.45', Currency: 'CNY' } }));
		expect(ok).toEqual({ available: 123.45, currency: 'CNY' });
		expect(parseAliyunBalance(JSON.stringify({ Data: { AvailableAmount: 8 } })).currency).toBe('CNY'); // 货币缺省

		// 真实账号形态：成功响应同样带 Code "200" / Message "success"（曾据此误判）
		const realShape = parseAliyunBalance(JSON.stringify({ RequestId: 'r', HostId: 'business.aliyuncs.com', Code: '200', Message: 'success', Data: { AvailableAmount: '56.78', AvailableCashAmount: '6.78', Currency: 'CNY' } }));
		expect(realShape).toEqual({ available: 56.78, currency: 'CNY' });

		try {
			parseAliyunBalance(JSON.stringify({ Code: 'InvalidAccessKeyId.NotFound', Message: 'Specified access key is not found.' }));
			expect.unreachable();
		} catch (err) {
			expect((err as { kind?: string }).kind).toBe('unauthorized');
			expect((err as Error).message).toContain('InvalidAccessKeyId');
		}
		try {
			parseAliyunBalance(JSON.stringify({ Code: 'Throttling.User', Message: 'slow down' }));
		} catch (err) {
			expect((err as { kind?: string }).kind).toBe('rateLimited');
		}
		try {
			parseAliyunBalance(JSON.stringify({ Code: 'InternalError', Message: 'oops' }));
		} catch (err) {
			expect((err as { kind?: string }).kind).toBe('unavailable');
		}
		expect(() => parseAliyunBalance(JSON.stringify({ Data: {} }))).toThrow(/AvailableAmount/);
	});

	it('fetchAliyunBalance：端到端（脚本化）成功路径，确定性 nonce/timestamp', async () => {
		const { fetchImpl, calls } = scriptedFetch([
			jsonRoute('business.aliyuncs.com', { Data: { AvailableAmount: '56.78', Currency: 'CNY' } }),
		]);
		const bal = await fetchAliyunBalance(AK, { fetchImpl, now: () => NOW, randomUUID: () => 'nonce-1' });
		expect(bal).toEqual({ available: 56.78, currency: 'CNY' });
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toContain('SignatureNonce=nonce1');
		expect(calls[0].url).toContain('Signature=');
	});
});

describe('Qwen × 阿里云余额融合', () => {
	const qwenInfo = jsonRoute('/tool/user/info.json', { code: '200', data: { secToken: 'st' } });
	const subscription = bodyRoute('v2/subscription', { successResponse: true, data: { specCode: 'token-plan-lite' } });
	const quotaConfig = bodyRoute('v2/quota-config', { successResponse: true, data: { plans: { 'token-plan-lite': { five_hour: 1_000_000, weekly: 4_000_000 } } } });
	const planUsage = bodyRoute('v2/usage', { successResponse: true, data: { DataV2: JSON.stringify({ per5HourPercentage: 0.32, per1WeekPercentage: 0.53 }) } });
	const paygUsage = bodyRoute('v2/usage', { successResponse: true, data: { DataV2: JSON.stringify({ ret: 'SUCCESS::接口调用成功', data: { msg: 'Success.', code: 'SUCCESS', requestId: 'r' } }) } });
	const bssBalance = jsonRoute('business.aliyuncs.com', { Data: { AvailableAmount: '56.78', Currency: 'CNY' } });

	it('套餐成功 + AK → 套餐快照附带余额；PAYG + AK → 余额快照；PAYG 无 AK → noPlan', async () => {
		const withPlan = scriptedFetch([qwenInfo, subscription, quotaConfig, planUsage, bssBalance]);
		const snap1 = await fetchQwenSnapshot('cna=x', { fetchImpl: withPlan.fetchImpl, now: NOW, aliyunAccessKey: AK });
		expect(snap1.billingMode).toBe('plan');
		expect(snap1.balance).toEqual({ value: 56.78, currency: 'CNY' });
		expect(snap1.windows).toHaveLength(2);
		expect(withPlan.calls.some(c => c.url.includes('business.aliyuncs.com'))).toBe(true);

		const payg = scriptedFetch([qwenInfo, subscription, quotaConfig, paygUsage, bssBalance]);
		const snap2 = await fetchQwenSnapshot('cna=x', { fetchImpl: payg.fetchImpl, now: NOW, aliyunAccessKey: AK });
		expect(snap2.billingMode).toBe('payg');
		expect(snap2.balance).toEqual({ value: 56.78, currency: 'CNY' });
		expect(snap2.windows).toEqual([]);
		expect(snap2.source).toBe('official-api');

		const noAk = scriptedFetch([qwenInfo, subscription, quotaConfig, paygUsage]);
		await expect(fetchQwenSnapshot('cna=x', { fetchImpl: noAk.fetchImpl, now: NOW })).rejects.toMatchObject({ kind: 'noPlan' });
	});

	it('绑定 AK 后余额查询失败 → 显示余额错误（不再误报 noPlan）', async () => {
		const brokenAk = scriptedFetch([
			qwenInfo, subscription, quotaConfig, paygUsage,
			jsonRoute('business.aliyuncs.com', { Code: 'InvalidAccessKeyId.NotFound', Message: 'not found' }),
		]);
		await expect(fetchQwenSnapshot('cna=x', { fetchImpl: brokenAk.fetchImpl, now: NOW, aliyunAccessKey: AK }))
			.rejects.toMatchObject({ kind: 'unauthorized' });
	});
});

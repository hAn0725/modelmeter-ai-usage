/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Account connect/manage commands — VS Code native QuickPick / InputBox only,
 * no dedicated account-center webview (0.3.0 spec).
 *
 *   modelMeter.manageAccounts      → pick provider → connect / reconnect / disconnect
 *   modelMeter.showAccountSection  → focus the existing sidebar and expand the
 *                                    account of the currently observed provider
 */

import * as vscode from 'vscode';
import type { AccountProviderId } from './types';
import { ACCOUNT_PROVIDERS, getProviderDef } from './providerRegistry';
import type { AccountUsageService } from './accountUsageService';
import type { AccountCredentialStore } from './credentialStore';
import { parseAliyunAccessKey, serializeAliyunAccessKey } from './aliyunBss';
import { browserLogin, BrowserLoginUnsupportedError } from './browserLogin';
import { verifyQwenCookie } from './providers/qwen';

export interface AccountCommandDeps {
	service: AccountUsageService;
	credentials: AccountCredentialStore;
	/** Focus modelMeter.main and expand the given provider's account row. */
	focusAccountSection: (provider: AccountProviderId | null) => void;
	/** Re-render sidebar/status bar after connection changes (debounced by callers). */
	notifyViews: () => void;
}

function isProviderId(value: unknown): value is AccountProviderId {
	return typeof value === 'string' && ACCOUNT_PROVIDERS.some(p => p.id === value);
}

const MANUAL_COOKIE_HINTS: Partial<Record<AccountProviderId, string>> = {
	qwen: '在已登录的浏览器中打开对应控制台（中国大陆：百炼 / 国际：Qwen Cloud），从开发者工具 Network 标签复制已登录请求的 Cookie 请求头。',
	mimo: '在浏览器打开 platform.xiaomimimo.com/console/plan-manage 并登录，从开发者工具复制 Cookie 请求头（需包含 userId、api-platform_slh、api-platform_ph）。',
};

export function registerAccountCommands(context: vscode.ExtensionContext, deps: AccountCommandDeps): void {
	const { service } = deps;

	context.subscriptions.push(vscode.commands.registerCommand('modelMeter.showAccountSection', (arg?: unknown) => {
		const provider = isProviderId(arg) ? arg : service.currentProvider();
		deps.focusAccountSection(provider);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('modelMeter.manageAccounts', async (arg?: unknown) => {
		let providerId: AccountProviderId | undefined = isProviderId(arg) ? arg : undefined;
		if (!providerId) {
			const state = service.getAll();
			const items = ACCOUNT_PROVIDERS.map(def => {
				const view = state.find(s => s.provider === def.id);
				const regionLabel = view?.region ? def.regions?.find(r => r.id === view.region)?.label : undefined;
				const description = view?.connected
					? `已连接${regionLabel ? ` · ${regionLabel}` : ''}`
					: '未连接';
				return { label: def.displayName, description, def };
			});
			const pick = await vscode.window.showQuickPick(items, {
				title: 'ModelMeter — 账户与套餐',
				placeHolder: '选择要管理的账户…',
				ignoreFocusOut: true,
			});
			if (!pick) { return; }
			providerId = pick.def.id;
		}

		const def = getProviderDef(providerId);
		if (!def) { return; }
		const view = service.get(providerId);
		type Action = { label: string; action: 'connect' | 'reconnect' | 'disconnect' | 'setAliyunAk' | 'removeAliyunAk' };
		const actions: Action[] = [];
		if (!view.connected) {
			actions.push({ label: '$(plug) 连接…', action: 'connect' });
		} else {
			actions.push({ label: '$(sync) 重新连接…', action: 'reconnect' });
			actions.push({ label: '$(circle-slash) 断开', action: 'disconnect' });
		}
		if (providerId === 'qwen') {
			const hasAliyunAk = Boolean(await deps.credentials.get('qwen', 'aliyunAk'));
			actions.push(hasAliyunAk
				? { label: '$(trash) 移除阿里云余额（AccessKey）', action: 'removeAliyunAk' }
				: { label: '$(cloud) 绑定阿里云账户余额（AccessKey）…', action: 'setAliyunAk' });
		}
		const act = await vscode.window.showQuickPick(actions, {
			title: `${def.displayName}${view.connected ? '（已连接）' : ''}`,
			placeHolder: '选择操作…',
			ignoreFocusOut: true,
		});
		if (!act) { return; }

		if (act.action === 'disconnect') {
			await service.disconnect(providerId);
			deps.notifyViews();
			vscode.window.showInformationMessage(`ModelMeter：${def.displayName} 账户已断开。`);
			return;
		}

		if (act.action === 'setAliyunAk') {
			const id = await vscode.window.showInputBox({
				title: '阿里云 AccessKey ID',
				prompt: '用于查询阿里云账户余额（百炼消耗的就是它）。建议在阿里云控制台创建仅含只读权限的 RAM 用户；仅保存到 VS Code 安全存储。',
				placeHolder: 'LTAI…',
				ignoreFocusOut: true,
			});
			if (!id) { return; }
			const secret = await vscode.window.showInputBox({
				title: '阿里云 AccessKey Secret',
				prompt: '仅保存到 VS Code 安全存储（SecretStorage），不会写入设置、数据库或日志。',
				password: true,
				ignoreFocusOut: true,
			});
			if (!secret) { return; }
			await deps.credentials.set('qwen', 'aliyunAk', serializeAliyunAccessKey({ id, secret }));
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'ModelMeter：正在查询阿里云账户余额…', cancellable: false },
				async () => { await service.refresh('qwen'); },
			);
			deps.notifyViews();
			const refreshed = service.get('qwen').cached;
			if (refreshed?.snapshot?.balance) {
				vscode.window.showInformationMessage('ModelMeter：阿里云账户余额已绑定并查询成功。');
			} else {
				vscode.window.showWarningMessage(`ModelMeter：AccessKey 已保存，但余额查询未成功${refreshed?.lastError ? `（${refreshed.lastError.message.slice(0, 120)}）` : ''}，可在侧边栏点 ↻ 重试。`);
			}
			return;
		}

		if (act.action === 'removeAliyunAk') {
			await deps.credentials.delete('qwen', 'aliyunAk');
			deps.notifyViews();
			vscode.window.showInformationMessage('ModelMeter：阿里云余额绑定已移除。');
			return;
		}

		// Region pick (only providers that actually have regions).
		let region: string | undefined = service.region(providerId);
		if (def.regions && def.regions.length > 0) {
			const regionPick = await vscode.window.showQuickPick(
				def.regions.map(r => ({ label: r.label, description: r.id === region ? '当前' : r.id, id: r.id })),
				{ title: `${def.displayName} — 选择区域`, ignoreFocusOut: true },
			);
			if (!regionPick) { return; }
			region = regionPick.id;
		}

		let credential: string | undefined;
		if (def.credential === 'apiKey') {
			credential = await vscode.window.showInputBox({
				title: `${def.displayName} — API Key`,
				prompt: '密钥仅保存到 VS Code 安全存储（SecretStorage），不会写入设置、数据库或日志。',
				placeHolder: '粘贴 API Key…',
				password: true,
				ignoreFocusOut: true,
			});
		} else {
			credential = await acquireCookie(def.id, def.displayName, region ?? service.region(def.id));
		}
		if (!credential) { return; }

		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `ModelMeter：正在验证 ${def.displayName} 账户…`, cancellable: false },
			async () => { await service.connect(providerId, credential as string, region); },
		);
		deps.notifyViews();
		const after = service.get(providerId);
		if (after.cached?.snapshot) {
			vscode.window.showInformationMessage(`ModelMeter：${def.displayName} 账户已连接。`);
		} else if (after.cached?.lastError?.kind === 'unauthorized') {
			vscode.window.showWarningMessage(`ModelMeter：${def.displayName} 凭据无效或已过期，请重新连接。`);
		} else {
			vscode.window.showWarningMessage(`ModelMeter：${def.displayName} 凭据已保存，但首次读取失败，可在侧边栏账户区点击 ↻ 重试。`);
		}
	}));
}

async function acquireCookie(providerId: AccountProviderId, displayName: string, region: string | undefined): Promise<string | undefined> {
	const def = getProviderDef(providerId);
	const login = def?.login;
	const method = await vscode.window.showQuickPick(
		[
			{ label: '$(globe) 浏览器登录（自动获取 Cookie）', description: '使用本机 Edge / Chrome（临时配置目录）', id: 'browser' as const },
			{ label: '$(clippy) 手动粘贴 Cookie', description: '自动登录失败时的备用方式', id: 'manual' as const },
		],
		{ title: `${displayName} — 登录方式`, ignoreFocusOut: true },
	);
	if (!method) { return undefined; }

	if (method.id === 'browser' && login) {
		const loginUrl = def?.regions?.find(r => r.id === region)?.loginUrl ?? login.loginUrl;
		try {
			const cookie = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `ModelMeter：${displayName} 浏览器登录`, cancellable: true },
				async (progress, token) => {
					let cancelled = false;
					token.onCancellationRequested(() => { cancelled = true; });
					return browserLogin({
						loginUrl,
						domains: login.domains,
						cookieNames: login.cookieNames,
						verify: providerId === 'qwen'
							? (header) => verifyQwenCookie(header, { region })
							: undefined,
						onProgress: (message) => progress.report({ message }),
						timeoutMs: 5 * 60 * 1000,
					}).then(value => (cancelled ? undefined : value));
				},
			);
			if (cookie) { return cookie; }
		} catch (err) {
			if (err instanceof BrowserLoginUnsupportedError) {
				vscode.window.showWarningMessage(`ModelMeter：${err.message} 将切换到手动 Cookie。`);
			} else {
				vscode.window.showWarningMessage(`ModelMeter：浏览器登录未完成（${err instanceof Error ? err.message : String(err)}），可改用手动 Cookie。`);
			}
		}
	}

	return vscode.window.showInputBox({
		title: `${displayName} — Cookie（手动）`,
		prompt: MANUAL_COOKIE_HINTS[providerId] ?? '从浏览器开发者工具复制 Cookie 请求头。',
		placeHolder: 'name=value; name2=value2; …',
		password: true,
		ignoreFocusOut: true,
	});
}

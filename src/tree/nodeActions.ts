/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { TreeNode } from './treeTypes';

/**
 * Registers all tree node action commands and returns their disposables.
 */
let _nodeActionsExtensionPath = '';
let _nodeActionsRefresh: () => void = () => {};
export function setExtensionPath(p: string): void {
	_nodeActionsExtensionPath = p;
}
export function setTreeRefresher(refresh: () => void): void {
	_nodeActionsRefresh = refresh;
}
export function registerNodeActions(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		// Generic refresh command — can be called from any flow
		vscode.commands.registerCommand('modelMeter.refreshTree', () => {
			_nodeActionsRefresh();
		}),

		// ─── Open help doc ───────────────────────────────────────────────
		vscode.commands.registerCommand('modelMeter.openHelpDoc', async (arg?: string | TreeNode) => {
			if (!_nodeActionsExtensionPath) {
				vscode.window.showErrorMessage('扩展路径不可用。');
				return;
			}
			// arg can be a filename string (from label click) or a TreeNode (from context menu button)
			let filename: string | undefined;
			if (typeof arg === 'string') {
				filename = arg;
			} else if (arg instanceof TreeNode) {
				filename = arg.id;
			}
			if (!filename) {
				vscode.window.showErrorMessage('未指定帮助文档。');
				return;
			}
			const helpPath = path.join(_nodeActionsExtensionPath, 'help', filename);
			const helpUri = vscode.Uri.file(helpPath);
			try {
				await vscode.commands.executeCommand('markdown.showPreview', helpUri);
			} catch {
				vscode.window.showErrorMessage(`无法打开帮助文档：${filename}`);
			}
		}),

	);
}



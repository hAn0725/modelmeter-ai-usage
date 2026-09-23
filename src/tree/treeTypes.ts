/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SessionSummary } from '../tokenUsage/metricsDatabase';

/**
 * Discriminating union of all possible tree node types.
 */
export type TreeNodeType =
	| 'usageSection'
	| 'usageVendor'
	| 'usageModel'
	| 'sessionSection'
	| 'sessionNode'
	| 'helpSection'
	| 'helpItem';

/**
 * Wraps a data object + type metadata for the TreeDataProvider.
 * The TreeItem itself is built lazily in getTreeItem().
 */
export class TreeNode {
	constructor(
		/** Discriminating type for context menu scoping. */
		readonly type: TreeNodeType,
		/** Unique identifier within the tree (used for stable identity across refreshes). */
		readonly id: string,
		/** Human-readable label. */
		readonly label: string,
		/** Reference to the underlying data object. */
		readonly data: SessionSummary | undefined,
		/** Optional description (shown dimmed next to the label). */
		readonly description?: string,
		/** Optional tooltip text. */
		readonly tooltip?: string,
	) { }

	/** Build the VS Code TreeItem DOM representation. */
	toTreeItem(): vscode.TreeItem {
		const item = new vscode.TreeItem(this.label);

		item.id = this.id;
		item.description = this.description;
		item.tooltip = this.tooltip ?? this.label;
		item.contextValue = this.type;

		// Collapsibility and command based on type
		switch (this.type) {
			case 'usageSection':
				item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
				item.iconPath = new vscode.ThemeIcon('dashboard');
				break;

			case 'usageVendor':
				item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
				item.iconPath = new vscode.ThemeIcon('flame');
				break;

			case 'usageModel':
				item.collapsibleState = vscode.TreeItemCollapsibleState.None;
				item.iconPath = new vscode.ThemeIcon('symbol-method');
				// Click opens model dashboard
				item.command = {
					command: 'modelMeter.openUsageModel',
					title: '打开模型用量',
					arguments: [this],
				};
				break;

			case 'sessionSection':
				item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
				// Default: comment-discussion. Filter icon when description doesn't start with "last 7d"
				if (this.description && !this.description.startsWith('最近 7 天')) {
					item.iconPath = new vscode.ThemeIcon('filter');
				} else {
					item.iconPath = new vscode.ThemeIcon('comment-discussion');
				}
				break;

			case 'sessionNode': {
				item.collapsibleState = vscode.TreeItemCollapsibleState.None;
				item.iconPath = new vscode.ThemeIcon('comment');
				const session = this.data as SessionSummary | undefined;
				if (session?.session_id) {
					item.command = {
						command: 'modelMeter.showSessionDetail',
						title: '打开会话详情',
						arguments: [session.session_id],
					};
				}
				break;
			}

			case 'helpSection':
				item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
				item.iconPath = new vscode.ThemeIcon('question');
				break;

			case 'helpItem': {
				item.collapsibleState = vscode.TreeItemCollapsibleState.None;
				item.iconPath = new vscode.ThemeIcon('book');
				// Primary click opens the help doc
				item.command = {
					command: 'modelMeter.openHelpDoc',
					title: '打开帮助',
					arguments: [this.id],
				};
				break;
			}
		}

		return item;
	}
}

/**
 * "Active Sessions" TreeView.
 *
 * Aggregates three live sources from the Flywheel MCP:
 *   - running executions (`flywheel_list_executions(status='running')`)
 *   - open approval sessions (`flywheel_list_approval_sessions`)
 *
 * Refresh cadence: 5s while the view is visible. Click a row → fires the
 * `flywheel.openNodeById` command with the target node_id.
 *
 * Stage-leases (`flywheel_get_node` returning `lease_holder`) are out of
 * scope for the MVP — they require N gets per refresh and we don't yet have
 * a useful aggregator endpoint.
 */

import * as vscode from 'vscode';
import {
  type FlywheelMcpClient,
  listApprovalSessions,
  listExecutions,
} from 'flywheel-core';

type Item = ExecutionItem | ApprovalItem | GroupItem;

interface ExecutionItem {
  kind: 'execution';
  execution_id: string;
  node_id: string;
  title: string;
  started_at: string;
}

interface ApprovalItem {
  kind: 'approval';
  session_id: string;
  node_id: string;
  opened_by: string;
  opened_at: string;
}

interface GroupItem {
  kind: 'group';
  label: string;
  children: Item[];
}

const REFRESH_MS = 5_000;

export class SessionsTreeProvider implements vscode.TreeDataProvider<Item> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private executions: ExecutionItem[] = [];
  private approvals: ApprovalItem[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight = false;
  private visible = false;
  private lastErrorAt = 0;

  constructor(
    private readonly clientFactory: () => FlywheelMcpClient,
  ) {}

  /** Drive refresh from the view visibility events. */
  bind(view: vscode.TreeView<Item>): vscode.Disposable {
    const onVis = view.onDidChangeVisibility((e) => {
      this.visible = e.visible;
      if (e.visible) this.startRefresh();
      else this.stopRefresh();
    });
    if (view.visible) {
      this.visible = true;
      this.startRefresh();
    }
    return new vscode.Disposable(() => {
      onVis.dispose();
      this.stopRefresh();
    });
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  private startRefresh(): void {
    if (this.timer !== null) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), REFRESH_MS);
  }

  private stopRefresh(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.inflight || !this.visible) return;
    this.inflight = true;
    try {
      const c = this.clientFactory();
      const [exec, appr] = await Promise.all([
        listExecutions(c, 'running').catch(() => ({ executions: [] })),
        listApprovalSessions(c).catch(() => ({ sessions: [] })),
      ]);
      this.executions = exec.executions.map((e) => ({
        kind: 'execution',
        execution_id: e.execution_id,
        node_id: e.node_id,
        title: e.title ?? e.execution_id.slice(0, 8),
        started_at: e.started_at,
      }));
      this.approvals = appr.sessions.map((s) => ({
        kind: 'approval',
        session_id: s.session_id,
        node_id: s.node_id,
        opened_by: s.opened_by,
        opened_at: s.opened_at,
      }));
      this.refresh();
    } catch (err) {
      const now = Date.now();
      if (now - this.lastErrorAt > 60_000) {
        this.lastErrorAt = now;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[flywheel sessions] ${msg}`);
      }
    } finally {
      this.inflight = false;
    }
  }

  getTreeItem(element: Item): vscode.TreeItem {
    if (element.kind === 'group') {
      const t = new vscode.TreeItem(
        `${element.label} (${element.children.length})`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      t.contextValue = 'flywheel.group';
      return t;
    }
    if (element.kind === 'execution') {
      const t = new vscode.TreeItem(
        `▶ ${element.title}`,
        vscode.TreeItemCollapsibleState.None,
      );
      t.description = new Date(element.started_at).toLocaleTimeString();
      t.tooltip = `Execution ${element.execution_id}\nNode ${element.node_id}\nStarted ${element.started_at}`;
      t.iconPath = new vscode.ThemeIcon('debug-start');
      t.contextValue = 'flywheel.execution';
      t.command = {
        command: 'flywheel.openNodeById',
        title: 'Open node',
        arguments: [element.node_id],
      };
      return t;
    }
    const t = new vscode.TreeItem(
      `✋ ${element.opened_by}`,
      vscode.TreeItemCollapsibleState.None,
    );
    t.description = new Date(element.opened_at).toLocaleTimeString();
    t.tooltip = `Approval session ${element.session_id}\nNode ${element.node_id}`;
    t.iconPath = new vscode.ThemeIcon('shield');
    t.contextValue = 'flywheel.approval';
    t.command = {
      command: 'flywheel.openNodeById',
      title: 'Open node',
      arguments: [element.node_id],
    };
    return t;
  }

  getChildren(element?: Item): Item[] {
    if (!element) {
      const groups: GroupItem[] = [
        { kind: 'group', label: 'Running executions', children: this.executions },
        { kind: 'group', label: 'Open approval sessions', children: this.approvals },
      ];
      return groups.filter((g) => g.children.length > 0);
    }
    if (element.kind === 'group') return element.children;
    return [];
  }
}

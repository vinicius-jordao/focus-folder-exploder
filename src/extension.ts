import * as path from "node:path";
import * as vscode from "vscode";

const CONTEXT_KEY = "focusFolder.hasActiveFocus";
const STATE_KEY = "focusFolder.state";
const VIEW_CONTAINER_ID = "focusFolder";
const VIEW_ID = "focusFolder.tree";

interface FocusState {
  focusedFolder: string;
}

type FilesExcludeEntry = boolean | { when?: string };
type FilesExcludeMap = Record<string, FilesExcludeEntry>;

interface LegacyFocusState {
  originalExclude?: FilesExcludeMap;
  selectedFolder?: string;
  target?: "workspace" | "workspaceFolder";
  workspaceFolder?: string;
}

class FocusedFolderItem {
  readonly resource: { uri: vscode.Uri };

  constructor(
    readonly uri: vscode.Uri,
    readonly type: vscode.FileType,
  ) {
    this.resource = { uri };
  }
}

class FocusedFolderProvider implements vscode.TreeDataProvider<FocusedFolderItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();

  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private focusedFolder?: vscode.Uri;

  setFocusedFolder(uri: vscode.Uri | undefined): void {
    this.focusedFolder = uri;
    this.onDidChangeTreeDataEmitter.fire();
  }

  getFocusedFolder(): vscode.Uri | undefined {
    return this.focusedFolder;
  }

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  async getChildren(element?: FocusedFolderItem): Promise<FocusedFolderItem[]> {
    const parentUri = element?.uri ?? this.focusedFolder;
    if (!parentUri) {
      return [];
    }

    const parentType = element?.type ?? vscode.FileType.Directory;
    if ((parentType & vscode.FileType.Directory) === 0) {
      return [];
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(parentUri);
    const excludeMap = workspaceFolder
      ? vscode.workspace.getConfiguration("files", parentUri).get<FilesExcludeMap>("exclude") ?? {}
      : {};
    const entries = await vscode.workspace.fs.readDirectory(parentUri);
    const visibleEntries: Array<[string, vscode.FileType]> = [];

    for (const entry of entries) {
      const [name, type] = entry;
      const uri = vscode.Uri.joinPath(parentUri, name);
      if (workspaceFolder && await isExcludedByFilesConfig(uri, type, workspaceFolder, excludeMap)) {
        continue;
      }

      visibleEntries.push(entry);
    }

    return visibleEntries
      .sort(compareEntries)
      .map(([name, type]) => new FocusedFolderItem(vscode.Uri.joinPath(parentUri, name), type));
  }

  getTreeItem(element: FocusedFolderItem): vscode.TreeItem {
    const isDirectory = (element.type & vscode.FileType.Directory) !== 0;
    const item = new vscode.TreeItem(
      path.basename(element.uri.fsPath),
      isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );

    item.resourceUri = element.uri;
    item.contextValue = isDirectory ? "directory" : "file";

    if (!isDirectory) {
      item.command = {
        command: "vscode.open",
        title: "Open File",
        arguments: [element.uri],
      };
    }

    return item;
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const provider = new FocusedFolderProvider();
  const treeView = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  const clearFocusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  clearFocusItem.command = "focusFolder.clearFocus";
  clearFocusItem.text = "$(close-all) Clear Focus";
  clearFocusItem.tooltip = "Clear the currently focused folder";

  context.subscriptions.push(treeView, clearFocusItem);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("files.exclude")) {
        provider.refresh();
      }
    }),
  );

  await restoreState(context, provider);
  await syncUiState(context, provider, treeView, clearFocusItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("focusFolder.focus", async (target?: vscode.Uri | FocusedFolderItem) => {
      await focusOnFolder(context, provider, treeView, clearFocusItem, target);
    }),
    vscode.commands.registerCommand("focusFolder.clearFocus", async () => {
      await clearFocus(context, provider, treeView, clearFocusItem);
    }),
    vscode.commands.registerCommand("focusFolder.revealInExplorer", async (target?: vscode.Uri | FocusedFolderItem) => {
      await revealInExplorer(resolveTargetUri(target));
    }),
  );
}

async function restoreState(
  context: vscode.ExtensionContext,
  provider: FocusedFolderProvider,
): Promise<void> {
  const state = context.workspaceState.get<unknown>(STATE_KEY);
  if (!state) {
    provider.setFocusedFolder(undefined);
    return;
  }

  if (isLegacyFocusState(state)) {
    await restoreLegacyExplorerState(state);
    await context.workspaceState.update(STATE_KEY, undefined);
    provider.setFocusedFolder(undefined);
    return;
  }

  if (!isFocusState(state)) {
    await context.workspaceState.update(STATE_KEY, undefined);
    provider.setFocusedFolder(undefined);
    return;
  }

  const focusedFolder = vscode.Uri.parse(state.focusedFolder);
  const folderStat = await safeStat(focusedFolder);
  if (!folderStat || (folderStat.type & vscode.FileType.Directory) === 0 || !isInWorkspace(focusedFolder)) {
    await context.workspaceState.update(STATE_KEY, undefined);
    provider.setFocusedFolder(undefined);
    return;
  }

  provider.setFocusedFolder(focusedFolder);
}

async function focusOnFolder(
  context: vscode.ExtensionContext,
  provider: FocusedFolderProvider,
  treeView: vscode.TreeView<FocusedFolderItem>,
  clearFocusItem: vscode.StatusBarItem,
  target?: vscode.Uri | FocusedFolderItem,
): Promise<void> {
  const resource = resolveTargetUri(target);
  if (!resource) {
    void vscode.window.showErrorMessage("Select a folder in the Explorer first.");
    return;
  }

  const folderStat = await safeStat(resource);
  if (!folderStat || (folderStat.type & vscode.FileType.Directory) === 0) {
    void vscode.window.showErrorMessage("Focus Folder only works on folders.");
    return;
  }

  if (!isInWorkspace(resource)) {
    void vscode.window.showErrorMessage("The selected folder must be inside the current workspace.");
    return;
  }

  await context.workspaceState.update(STATE_KEY, {
    focusedFolder: resource.toString(),
  } satisfies FocusState);

  provider.setFocusedFolder(resource);
  await syncUiState(context, provider, treeView, clearFocusItem);
  await openFocusedFolderView();
}

async function clearFocus(
  context: vscode.ExtensionContext,
  provider: FocusedFolderProvider,
  treeView: vscode.TreeView<FocusedFolderItem>,
  clearFocusItem: vscode.StatusBarItem,
): Promise<void> {
  await context.workspaceState.update(STATE_KEY, undefined);
  provider.setFocusedFolder(undefined);
  await syncUiState(context, provider, treeView, clearFocusItem);
}

async function syncUiState(
  context: vscode.ExtensionContext,
  provider: FocusedFolderProvider,
  treeView: vscode.TreeView<FocusedFolderItem>,
  clearFocusItem: vscode.StatusBarItem,
): Promise<void> {
  const focusedFolder = provider.getFocusedFolder();
  const isFocused = Boolean(focusedFolder);

  if (isFocused) {
    clearFocusItem.show();
  } else {
    clearFocusItem.hide();
  }

  treeView.title = focusedFolder ? path.basename(focusedFolder.fsPath) : "Focused Folder";
  treeView.description = focusedFolder ? vscode.workspace.asRelativePath(focusedFolder, true) : undefined;
  treeView.message = focusedFolder
    ? undefined
    : "Right-click a folder in the Explorer and choose Focus on This Folder.";

  await vscode.commands.executeCommand("setContext", CONTEXT_KEY, isFocused);
}

function resolveTargetUri(target?: vscode.Uri | FocusedFolderItem): vscode.Uri | undefined {
  if (!target) {
    return undefined;
  }

  if (target instanceof vscode.Uri) {
    return target;
  }

  return target.uri;
}

async function revealInExplorer(resource: vscode.Uri | undefined): Promise<void> {
  if (!resource) {
    return;
  }

  try {
    await vscode.commands.executeCommand("revealInExplorer", resource);
  } catch {
    // Ignore when the current host does not expose the built-in command.
  }
}

async function openFocusedFolderView(): Promise<void> {
  try {
    await vscode.commands.executeCommand(`workbench.view.extension.${VIEW_CONTAINER_ID}`);
  } catch {
    // Ignore when the workbench command is unavailable in the current host.
  }
}

async function safeStat(resource: vscode.Uri): Promise<vscode.FileStat | undefined> {
  try {
    return await vscode.workspace.fs.stat(resource);
  } catch {
    return undefined;
  }
}

function isInWorkspace(resource: vscode.Uri): boolean {
  return Boolean(vscode.workspace.getWorkspaceFolder(resource));
}

function isFocusState(value: unknown): value is FocusState {
  return Boolean(
    value &&
      typeof value === "object" &&
      "focusedFolder" in value &&
      typeof value.focusedFolder === "string",
  );
}

function isLegacyFocusState(value: unknown): value is LegacyFocusState {
  return Boolean(
    value &&
      typeof value === "object" &&
      "workspaceFolder" in value &&
      typeof value.workspaceFolder === "string" &&
      "target" in value &&
      (value.target === "workspace" || value.target === "workspaceFolder"),
  );
}

async function restoreLegacyExplorerState(state: LegacyFocusState): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.find(
    (folder) => folder.uri.toString() === state.workspaceFolder,
  );
  if (!workspaceFolder) {
    return;
  }

  const config = vscode.workspace.getConfiguration("files", workspaceFolder.uri);
  const target =
    state.target === "workspaceFolder"
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : vscode.ConfigurationTarget.Workspace;

  await config.update("exclude", state.originalExclude, target);
  await refreshNativeExplorer();
}

async function refreshNativeExplorer(): Promise<void> {
  try {
    await vscode.commands.executeCommand("workbench.files.action.refreshFilesExplorer");
  } catch {
    // Ignore when the workbench command is unavailable in the current host.
  }
}

async function isExcludedByFilesConfig(
  resource: vscode.Uri,
  fileType: vscode.FileType,
  workspaceFolder: vscode.WorkspaceFolder,
  excludeMap: FilesExcludeMap,
): Promise<boolean> {
  const relativePath = toPosixPath(path.relative(workspaceFolder.uri.fsPath, resource.fsPath));
  if (!relativePath) {
    return false;
  }

  for (const [pattern, entry] of Object.entries(excludeMap)) {
    if (!entry || !matchesGlob(relativePath, pattern, (fileType & vscode.FileType.Directory) !== 0)) {
      continue;
    }

    if (entry === true) {
      return true;
    }

    if (entry.when && await matchesWhenClause(resource, relativePath, entry.when)) {
      return true;
    }
  }

  return false;
}

async function matchesWhenClause(
  resource: vscode.Uri,
  relativePath: string,
  whenClause: string,
): Promise<boolean> {
  const filename = path.posix.basename(relativePath);
  const extension = path.posix.extname(filename);
  const basename = extension ? filename.slice(0, -extension.length) : filename;
  const siblingName = whenClause.replaceAll("$(basename)", basename);
  const parentUri = vscode.Uri.joinPath(resource, "..");

  try {
    await vscode.workspace.fs.stat(vscode.Uri.joinPath(parentUri, siblingName));
    return true;
  } catch {
    return false;
  }
}

function matchesGlob(relativePath: string, pattern: string, isDirectory: boolean): boolean {
  const normalizedPattern = toPosixPath(pattern);
  const target = isDirectory ? `${relativePath}/` : relativePath;
  const regex = new RegExp(`^${globToRegexSource(normalizedPattern)}$`, "u");

  return regex.test(target) || regex.test(relativePath);
}

function globToRegexSource(pattern: string): string {
  let index = 0;
  let source = "";

  while (index < pattern.length) {
    const char = pattern[index];

    if (char === "*") {
      const nextChar = pattern[index + 1];
      const nextNextChar = pattern[index + 2];
      if (nextChar === "*" && nextNextChar === "/") {
        source += "(?:.*/)?";
        index += 3;
        continue;
      }

      if (nextChar === "*") {
        source += ".*";
        index += 2;
        continue;
      }

      source += "[^/]*";
      index += 1;
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }

    if (char === "{") {
      const closingBraceIndex = pattern.indexOf("}", index + 1);
      if (closingBraceIndex !== -1) {
        const alternatives = pattern
          .slice(index + 1, closingBraceIndex)
          .split(",")
          .map((part) => globToRegexSource(part));
        source += `(?:${alternatives.join("|")})`;
        index = closingBraceIndex + 1;
        continue;
      }
    }

    source += escapeRegexCharacter(char);
    index += 1;
  }

  return source;
}

function escapeRegexCharacter(char: string): string {
  return /[|\\{}()[\]^$+?.]/u.test(char) ? `\\${char}` : char;
}

function toPosixPath(value: string): string {
  return value.replaceAll(path.sep, "/");
}

function compareEntries(
  [leftName, leftType]: [string, vscode.FileType],
  [rightName, rightType]: [string, vscode.FileType],
): number {
  const leftIsDirectory = (leftType & vscode.FileType.Directory) !== 0;
  const rightIsDirectory = (rightType & vscode.FileType.Directory) !== 0;

  if (leftIsDirectory !== rightIsDirectory) {
    return leftIsDirectory ? -1 : 1;
  }

  return leftName.localeCompare(rightName, undefined, { sensitivity: "base" });
}

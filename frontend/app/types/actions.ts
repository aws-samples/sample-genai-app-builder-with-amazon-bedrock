export type ActionType = 'file' | 'shell';

export interface BaseAction {
  content: string;
}

export interface FileAction extends BaseAction {
  type: 'file';
  filePath: string;
}

export interface ShellAction extends BaseAction {
  type: 'shell';
}

export type VibeAction = FileAction | ShellAction;

export type VibeActionData = VibeAction | BaseAction;

/** @deprecated Use VibeAction instead */
export type BoltAction = VibeAction;

/** @deprecated Use VibeActionData instead */
export type BoltActionData = VibeActionData;

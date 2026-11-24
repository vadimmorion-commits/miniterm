export interface PluginApi {
  /** Text currently selected in the active terminal pane. */
  getSelection(): string;
  copy(text: string): void;
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

export interface PluginHandle {
  /** Called when a file is opened in this tool from the explorer. */
  open?(path: string): void;
}

export interface Plugin {
  id: string;
  title: string;
  icon: string;
  /** File extensions (lowercase, no dot) this plugin opens from the explorer. */
  exts?: string[];
  mount(root: HTMLElement, api: PluginApi): PluginHandle | void;
}

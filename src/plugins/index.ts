import type { Plugin } from './types';
import { jsonViewer } from './json';
import { jsonDiff } from './jsondiff';
import { parquetViewer } from './parquet';
import { timeTool } from './time';

/** Loaded on first open only, so it costs nothing until used. */
const installTool: Plugin = {
  id: 'install',
  title: 'Установка',
  icon: '📦',
  mount(root, api) {
    root.textContent = 'Загрузка…';
    void import('./install').then(m => { root.textContent = ''; m.mountInstaller(root, api); });
  },
};

const httpTool: Plugin = {
  id: 'http',
  title: 'HTTP',
  icon: '🌐',
  mount(root, api) {
    root.textContent = 'Загрузка…';
    void import('./http').then(m => { root.textContent = ''; m.mountHttp(root, api); });
  },
};

/** Register new tools here. */
export const plugins: Plugin[] = [jsonViewer, jsonDiff, parquetViewer, timeTool, httpTool, installTool];
export type { Plugin, PluginApi, PluginHandle } from './types';

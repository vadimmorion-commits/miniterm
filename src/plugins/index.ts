import type { Plugin } from './types';
import { jsonViewer } from './json';
import { jsonDiff } from './jsondiff';
import { parquetViewer } from './parquet';
import { timeTool } from './time';

/** Register new tools here. */
export const plugins: Plugin[] = [jsonViewer, jsonDiff, parquetViewer, timeTool];
export type { Plugin, PluginApi, PluginHandle } from './types';

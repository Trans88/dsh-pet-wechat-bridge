import { constants, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { BridgeError, readJSONFile } from './lib.mjs';

// Keep machine-specific settings outside Git. Never overwrite an existing file.
export function loadConfig(root) {
  const path = join(root, 'config.json');
  if (!existsSync(path)) {
    try {
      copyFileSync(join(root, 'config.example.json'), path, constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw new BridgeError('无法创建 config.json，请检查 config.example.json 是否存在，以及目录是否可写。');
      }
    }
  }
  const config = readJSONFile(path);
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new BridgeError('config.json 必须是 JSON 对象，请参考 config.example.json。');
  }
  return config;
}

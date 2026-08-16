import fg from 'fast-glob';
import fs from 'fs';
import path from 'path';
import {ProjectData} from './plugins';

export async function createMeta(metaPath: string) {
  if (!fs.existsSync(metaPath)) {
    await fs.promises.writeFile(
      metaPath,
      JSON.stringify({version: 0}, undefined, 2),
      'utf8',
    );
  }
}

/**
 * A single `project` configuration entry: a path/glob, or an object pairing
 * an `include` path/glob with an optional index-page `group`.
 */
export type ProjectInput = string | {include: string; group?: string};

export function getProjects(
  project: ProjectInput | ProjectInput[],
): ProjectData[] {
  const list: ProjectData[] = [];
  for (const {filePath, group} of expandFilePaths(project)) {
    const {name, dir} = path.posix.parse(filePath);
    const metaFile = `${name}.meta`;
    const metaData = getMeta(path.join(dir, metaFile));
    const url = path.posix.join(dir, name);
    const data: ProjectData = {
      name: metaData?.name ?? url,
      fileName: name,
      url,
      filePath,
    };
    if (group !== undefined) {
      data.group = group;
    }
    list.push(data);
  }

  return list;
}

function expandFilePaths(
  inputs: ProjectInput | ProjectInput[],
): {filePath: string; group?: string}[] {
  const expanded: {filePath: string; group?: string}[] = [];

  for (const input of Array.isArray(inputs) ? inputs : [inputs]) {
    const {include, group} =
      typeof input === 'string' ? {include: input, group: undefined} : input;
    if (fg.isDynamicPattern(include)) {
      const matchingFilePaths = fg.sync(include, {onlyFiles: true});
      expanded.push(...matchingFilePaths.map(filePath => ({filePath, group})));
    } else {
      expanded.push({filePath: include, group});
    }
  }

  return expanded;
}

function getMeta(metaPath: string) {
  if (fs.existsSync(metaPath)) {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  }
}

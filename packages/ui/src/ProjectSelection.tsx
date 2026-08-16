import {useMemo, useState} from 'preact/hooks';
import {Header} from './components/layout';
import styles from './Index.module.scss';

export interface ProjectData {
  name: string;
  fileName: string;
  url: string;
  filePath: string;
  group?: string;
}

export interface ProjectSelectionProps {
  projects: ProjectData[];
}

interface ProjectVariant {
  label: string;
  project: ProjectData;
}

interface ProjectEntry {
  name: string;
  subtitle: string;
  /** Set for flat entries linking to a single project. */
  url?: string;
  variants: ProjectVariant[];
}

interface ProjectGroup {
  /** `undefined` for ungrouped projects, rendered as a flat list. */
  name?: string;
  entries: ProjectEntry[];
}

const SEPARATOR = /[\\/]/;

/** Segment-wise common directory prefix of all project paths. */
function commonPrefix(paths: string[][]): number {
  let prefix = 0;
  outer: while (paths.length > 1) {
    const segment = paths[0][prefix];
    if (segment === undefined) break;
    for (const path of paths) {
      if (path[prefix] !== segment) break outer;
    }
    prefix++;
  }
  return prefix;
}

/**
 * Turn a set of projects into display entries. When the set spans multiple
 * directories, the directory is the natural identity: projects sharing one
 * collapse into a single entry with the individual files as variants.
 * Otherwise the projects are listed as-is.
 */
function makeEntries(
  projects: ProjectData[],
  paths: string[][],
  prefix: number,
  group?: string,
): ProjectEntry[] {
  const directories = new Set(
    paths.map(path => path.slice(prefix, -1).join('/')),
  );

  // The group header (if any) already says where we are — strip a redundant
  // name prefix such as `examples-` inside an `examples` group.
  const displayName = (project: ProjectData) =>
    group !== undefined && project.name.startsWith(`${group}-`)
      ? project.name.slice(group.length + 1)
      : project.name;

  if (directories.size < 2) {
    return projects.map(project => ({
      name: displayName(project),
      subtitle: project.filePath,
      url: project.url,
      variants: [],
    }));
  }

  const entries = new Map<string, ProjectEntry & {projects: ProjectData[]}>();
  projects.forEach((project, index) => {
    const directory = paths[index].slice(prefix, -1);
    const key = directory.join('/');
    if (!entries.has(key)) {
      entries.set(key, {
        name: directory[directory.length - 1] ?? displayName(project),
        subtitle: paths[index].slice(0, -1).join('/'),
        variants: [],
        projects: [],
      });
    }
    entries.get(key)!.projects.push(project);
  });

  return [...entries.values()].map(entry => {
    if (entry.projects.length === 1) {
      const [project] = entry.projects;
      return {
        name: displayName(project),
        subtitle: project.filePath,
        url: project.url,
        variants: [],
      };
    }
    return {
      name: entry.name,
      subtitle: entry.subtitle,
      variants: entry.projects.map(project => ({
        label: project.fileName,
        project,
      })),
    };
  });
}

function groupProjects(projects: ProjectData[]): ProjectGroup[] {
  const paths = projects.map(project => project.filePath.split(SEPARATOR));
  const prefix = commonPrefix(paths);

  const sets = new Map<string | undefined, number[]>();
  projects.forEach((project, index) => {
    if (!sets.has(project.group)) {
      sets.set(project.group, []);
    }
    sets.get(project.group)!.push(index);
  });

  const groups: ProjectGroup[] = [];
  for (const [name, indices] of sets) {
    const group = {
      name,
      entries: makeEntries(
        indices.map(index => projects[index]),
        indices.map(index => paths[index]),
        prefix,
        name,
      ),
    };
    // Ungrouped projects always come first.
    if (name === undefined) {
      groups.unshift(group);
    } else {
      groups.push(group);
    }
  }
  return groups;
}

function matches(entry: ProjectEntry, needle: string): boolean {
  return (
    !needle ||
    entry.name.toLowerCase().includes(needle) ||
    entry.subtitle.toLowerCase().includes(needle) ||
    entry.variants.some(
      variant =>
        variant.label.toLowerCase().includes(needle) ||
        variant.project.name.toLowerCase().includes(needle) ||
        variant.project.filePath.toLowerCase().includes(needle),
    )
  );
}

function ProjectEntries({entries}: {entries: ProjectEntry[]}) {
  return (
    <>
      {entries.map(entry =>
        entry.variants.length === 0 ? (
          <a
            className={styles.element}
            key={entry.subtitle}
            href={`./${entry.url}`}
          >
            <div className={styles.title}>{entry.name}</div>
            <div className={styles.subtitle}>{entry.subtitle}</div>
          </a>
        ) : (
          <div className={styles.element} key={entry.subtitle}>
            <div className={styles.title}>{entry.name}</div>
            <div className={styles.subtitle}>{entry.subtitle}</div>
            <div className={styles.variants}>
              {entry.variants.map(variant => (
                <a
                  className={styles.variant}
                  key={variant.project.url}
                  href={`./${variant.project.url}`}
                >
                  {variant.label}
                </a>
              ))}
            </div>
          </div>
        ),
      )}
    </>
  );
}

export function ProjectSelection({projects}: ProjectSelectionProps) {
  const [query, setQuery] = useState('');
  const groups = useMemo(() => groupProjects(projects), [projects]);

  const needle = query.toLowerCase();
  const visible = groups
    .map(group => ({
      ...group,
      entries: group.entries.filter(entry => matches(entry, needle)),
    }))
    .filter(group => group.entries.length > 0);

  return (
    <div className={styles.root}>
      <Header className={styles.header}>
        Projects
        <input
          className={styles.search}
          type="search"
          placeholder="Filter projects…"
          value={query}
          onInput={event => setQuery((event.target as HTMLInputElement).value)}
        />
      </Header>
      <div className={styles.list}>
        {visible.map(group =>
          group.name === undefined ? (
            <ProjectEntries key="" entries={group.entries} />
          ) : (
            // Sections start collapsed; an active filter expands them so
            // matches are visible.
            <details
              className={styles.group}
              key={group.name}
              open={needle.length > 0}
            >
              <summary className={styles.groupTitle}>
                {group.name}
                <span className={styles.count}>{group.entries.length}</span>
              </summary>
              <ProjectEntries entries={group.entries} />
            </details>
          ),
        )}
        {visible.length === 0 && (
          <div className={styles.empty}>No projects match "{query}".</div>
        )}
      </div>
    </div>
  );
}

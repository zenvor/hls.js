#!/usr/bin/env node
/* eslint-env node */

const { execFileSync } = require('node:child_process');

const tag = process.argv[2] || process.env.TAG;

if (!tag) {
  console.error('Usage: node ./scripts/generate-release-notes.js <tag>');
  process.exit(1);
}

const repoUrl = 'https://github.com/zenvor/hls.js';
const previousTag = getPreviousTag(tag);
const commits = getCommits(tag, previousTag);
const grouped = groupCommits(commits);
const summary = buildSummary(grouped, commits.length);

const lines = [];
lines.push('# Summary');
lines.push(summary);
lines.push('');

lines.push(
  previousTag ? `# Changes Since ${previousTag}` : `# Changes In ${tag}`,
);
lines.push('');

appendThemeSections(lines, grouped.themes);

process.stdout.write(`${lines.join('\n')}\n`);

function appendThemeSections(lines, themes) {
  const visibleThemes = themes.filter((theme) => !theme.hidden);

  if (!visibleThemes.length) {
    lines.push('- 本次版本没有新增提交进入发布说明。');
    lines.push('');
    return;
  }

  visibleThemes.forEach((theme) => {
    lines.push(`**${theme.title}:**`);
    lines.push('');
    theme.items.forEach((item) => {
      lines.push(
        `- ${item.title} ([\`${item.shortSha}\`](${repoUrl}/commit/${item.sha}))`,
      );
      if (item.details.length) {
        item.details.forEach((detail) => {
          lines.push(`  - ${detail}`);
        });
      }
    });
    lines.push('');
  });
}

function buildSummary(grouped, total) {
  if (!total) {
    return `@zenvor/hls.js ${tag} 已发布。本次版本没有新增提交进入发布说明。`;
  }

  const playbackTheme = grouped.themes.find(
    (theme) => theme.key === 'playback-and-recovery',
  );
  const validationTheme = grouped.themes.find(
    (theme) => theme.key === 'validation',
  );

  if (playbackTheme) {
    let summary = `@zenvor/hls.js ${tag} 引入了自适应坏帧跳过能力，用于减少重复解码重试并提升异常片段恢复稳定性。`;
    if (validationTheme) {
      summary += ' 同时补充了与新恢复策略对应的测试覆盖。';
    }
    return summary;
  }

  const topThemes = grouped.themes
    .filter((theme) => !theme.hidden)
    .slice(0, 2)
    .map((theme) => theme.summaryLabel)
    .filter(Boolean);

  if (!topThemes.length) {
    return `@zenvor/hls.js ${tag} 已发布。本次版本主要包含维护性更新。`;
  }

  return `@zenvor/hls.js ${tag} 已发布。本次版本主要包含${topThemes.join('、')}。`;
}

function groupCommits(commits) {
  const themeMap = new Map();

  commits.forEach((commit) => {
    const theme = resolveTheme(commit);
    commit.details = deriveDetails(commit, theme.key);
    if (!themeMap.has(theme.key)) {
      themeMap.set(theme.key, {
        key: theme.key,
        title: theme.title,
        summaryLabel: theme.summaryLabel,
        priority: theme.priority,
        hidden: Boolean(theme.hidden),
        items: [],
      });
    }

    themeMap.get(theme.key).items.push(commit);
  });

  return {
    themes: Array.from(themeMap.values()).sort(
      (a, b) => a.priority - b.priority,
    ),
  };
}

function getCommits(currentTag, previousTag) {
  const range = previousTag ? `${previousTag}..${currentTag}` : currentTag;
  const output = execGit([
    'log',
    '--reverse',
    '--format=%H%x1f%s%x1f%b%x1e',
    range,
  ]);

  return output
    .split('\x1e')
    .filter(Boolean)
    .map((entry) => {
      const [sha, subject, body] = entry.split('\x1f');
      return parseCommit(sha, subject || '', body || '');
    })
    .filter((commit) => commit.title);
}

function parseCommit(sha, subject, body) {
  const trimmedSubject = subject.trim();
  const conventional = /^([a-z]+)(\([^)]+\))?(!)?:\s*(.+)$/i.exec(
    trimmedSubject,
  );
  const title = conventional ? conventional[4].trim() : trimmedSubject;
  const type = conventional ? conventional[1].toLowerCase() : 'other';
  const scope =
    conventional && conventional[2]
      ? conventional[2].slice(1, -1).toLowerCase()
      : '';
  const breaking =
    Boolean(conventional && conventional[3]) || /BREAKING CHANGE:/i.test(body);

  return {
    sha,
    shortSha: sha.slice(0, 8),
    subject: trimmedSubject,
    title,
    type,
    scope,
    body,
    breaking,
    isMerge: /^Merge\b/.test(trimmedSubject),
    details: [],
  };
}

function deriveDetails(commit, themeKey) {
  if (themeKey === 'release-workflow') {
    return [];
  }

  if (themeKey === 'playback-and-recovery') {
    return summarizePlaybackDetails(commit);
  }

  if (themeKey === 'validation') {
    return summarizeValidationDetails(commit);
  }

  return summarizeGenericDetails(commit);
}

function summarizePlaybackDetails(commit) {
  const text = `${commit.subject}\n${commit.body}`;
  const details = [];

  if (/exponential|退避|1s|2s|4s|8s/i.test(text)) {
    details.push('将固定跳跃改为指数退避，减少坏帧场景下的重复解码重试。');
  }
  if (/seekable\.end|duration|targetTime/i.test(text)) {
    details.push(
      '限制目标跳转时间不超过 `seekable.end` / `duration`，避免跳过过多内容。',
    );
  }
  if (/keyframe|关键帧/i.test(text)) {
    details.push('针对无法越过下一个关键帧的情况，改善异常片段恢复稳定性。');
  }

  return dedupeDetails(details, ['聚焦异常片段恢复与播放稳定性。']);
}

function summarizeValidationDetails(commit) {
  const text = `${commit.subject}\n${commit.body}`;
  const details = [];

  if (/targetTime|brokenFrameSkipSize/i.test(text)) {
    details.push('补充目标跳转时间计算相关断言，确保新跳过策略与预期一致。');
  }
  if (
    /cooldown|lastSkippedBrokenFromTime|lastSkippedBrokenFragSn/i.test(text)
  ) {
    details.push('覆盖冷却窗口状态更新，避免恢复逻辑回退到旧字段语义。');
  }
  if (/detachMedia|回滚/i.test(text)) {
    details.push('验证异常回滚路径，确保状态字段在 detach 场景下正确复位。');
  }

  return dedupeDetails(details, [
    '同步测试预期，确保新的恢复行为在关键路径上得到覆盖。',
  ]);
}

function summarizeGenericDetails(commit) {
  const lines = commit.body
    .split('\n')
    .map((line) => line.trim().replace(/^-+\s*/, ''))
    .filter(
      (line) =>
        line &&
        !/^BREAKING CHANGE:/i.test(line) &&
        !/^Co-Authored-By:/i.test(line),
    );

  return lines.slice(0, 2);
}

function dedupeDetails(details, fallback) {
  const unique = [...new Set(details.filter(Boolean))];
  return unique.length ? unique : fallback;
}

function resolveTheme(commit) {
  if (commit.breaking) {
    return {
      key: 'upgrade-notes',
      title: 'Upgrade Notes',
      summaryLabel: '升级兼容性调整',
      priority: 1,
    };
  }

  if (commit.isMerge) {
    return {
      key: 'internal-maintenance',
      title: 'Internal Maintenance',
      summaryLabel: '内部维护更新',
      priority: 5,
    };
  }

  if (
    commit.scope === 'test' ||
    /test|spec|assert|coverage/i.test(commit.subject)
  ) {
    return {
      key: 'validation',
      title: 'Validation',
      summaryLabel: '测试与验证更新',
      priority: 3,
    };
  }

  if (
    commit.type === 'ci' ||
    commit.scope === 'ci' ||
    /workflow|publish|release|actions/i.test(commit.subject)
  ) {
    return {
      key: 'release-workflow',
      title: 'Release Workflow',
      summaryLabel: '',
      priority: 4,
      hidden: true,
    };
  }

  if (
    commit.type === 'feat' ||
    /algo|camera|frame|buffer|frag|stream|playback|recovery|skip/i.test(
      commit.subject,
    )
  ) {
    return {
      key: 'playback-and-recovery',
      title: 'Broken Frame Recovery',
      summaryLabel: '播放恢复能力改进',
      priority: 2,
    };
  }

  if (commit.type === 'fix') {
    return {
      key: 'bug-fixes',
      title: 'Bug Fixes',
      summaryLabel: '缺陷修复',
      priority: 2,
    };
  }

  if (commit.type === 'perf') {
    return {
      key: 'performance',
      title: 'Performance',
      summaryLabel: '性能优化',
      priority: 2,
    };
  }

  return {
    key: 'internal-maintenance',
    title: 'Internal Maintenance',
    summaryLabel: '内部维护更新',
    priority: 5,
  };
}

function getPreviousTag(currentTag) {
  try {
    return execFileSync(
      'git',
      ['describe', '--tags', '--abbrev=0', '--match', 'v*', `${currentTag}^`],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
  } catch {
    return '';
  }
}

function execGit(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  }).trim();
}

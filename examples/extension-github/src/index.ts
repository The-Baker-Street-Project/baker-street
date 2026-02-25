import { createExtension } from '@bakerst/extension-sdk';
import { Octokit } from '@octokit/rest';
import { z } from 'zod';

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error('GITHUB_TOKEN environment variable is required');
  process.exit(1);
}

const octokit = new Octokit({ auth: token });

const ext = createExtension({
  id: 'github',
  name: 'GitHub',
  version: '0.1.0',
  description: 'GitHub repository, issue, and pull request tools',
  tags: ['github', 'vcs', 'code'],
});

const MAX_BODY = 8192;

function truncate(text: string, max = MAX_BODY): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n... (truncated, ${text.length} chars total)`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

// ---------- Repository Tools ----------

ext.server.tool(
  'github_search_repos',
  'Search GitHub repositories by query. Returns name, description, stars, language, and URL.',
  { query: z.string(), per_page: z.number().optional() },
  // @ts-expect-error — MCP SDK generics cause TS2589
  async ({ query, per_page }: { query: string; per_page?: number }) => {
    try {
      const { data } = await octokit.search.repos({ q: query, per_page: per_page ?? 10 });
      const results = data.items.map((r) =>
        `${r.full_name} (${r.stargazers_count} stars)\n  ${r.description ?? 'No description'}\n  Language: ${r.language ?? 'N/A'}\n  URL: ${r.html_url}`,
      );
      return ok(`Found ${data.total_count} repositories:\n\n${results.join('\n\n')}`);
    } catch (e) {
      return err(`Search failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

ext.server.tool(
  'github_get_repo',
  'Get metadata for a GitHub repository. Provide owner and repo name.',
  { owner: z.string(), repo: z.string() },
  async ({ owner, repo }: { owner: string; repo: string }) => {
    try {
      const { data: r } = await octokit.repos.get({ owner, repo });
      const lines = [
        `${r.full_name}`,
        `Description: ${r.description ?? 'None'}`,
        `Language: ${r.language ?? 'N/A'}`,
        `Stars: ${r.stargazers_count} | Forks: ${r.forks_count} | Open issues: ${r.open_issues_count}`,
        `Default branch: ${r.default_branch}`,
        `Created: ${r.created_at} | Updated: ${r.updated_at}`,
        `URL: ${r.html_url}`,
        `Topics: ${r.topics?.join(', ') || 'None'}`,
        `License: ${r.license?.spdx_id ?? 'None'}`,
        `Visibility: ${r.visibility ?? (r.private ? 'private' : 'public')}`,
      ];
      return ok(lines.join('\n'));
    } catch (e) {
      return err(`Failed to get repo: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

// ---------- Issue Tools ----------

ext.server.tool(
  'github_list_issues',
  'List issues for a repository. Supports state filter (open/closed/all) and labels.',
  { owner: z.string(), repo: z.string(), state: z.enum(['open', 'closed', 'all']).optional(), labels: z.string().optional(), per_page: z.number().optional() },
  // @ts-expect-error — MCP SDK generics cause TS2589
  async ({ owner, repo, state, labels, per_page }: { owner: string; repo: string; state?: string; labels?: string; per_page?: number }) => {
    try {
      const { data } = await octokit.issues.listForRepo({
        owner, repo,
        state: (state ?? 'open') as 'open' | 'closed' | 'all',
        labels,
        per_page: per_page ?? 20,
      });
      // Filter out pull requests (GitHub API returns PRs in issues endpoint)
      const issues = data.filter((i) => !i.pull_request);
      if (issues.length === 0) return ok('No issues found.');
      const lines = issues.map((i) =>
        `#${i.number} [${i.state}] ${i.title}\n  Labels: ${i.labels.map((l) => typeof l === 'string' ? l : l.name).join(', ') || 'none'}\n  Assignees: ${i.assignees?.map((a) => a.login).join(', ') || 'none'}\n  Created: ${i.created_at} by ${i.user?.login ?? 'unknown'}`,
      );
      return ok(lines.join('\n\n'));
    } catch (e) {
      return err(`Failed to list issues: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

ext.server.tool(
  'github_get_issue',
  'Get details of a specific issue including body and comments.',
  { owner: z.string(), repo: z.string(), issue_number: z.number() },
  // @ts-expect-error — MCP SDK generics cause TS2589
  async ({ owner, repo, issue_number }: { owner: string; repo: string; issue_number: number }) => {
    try {
      const { data: issue } = await octokit.issues.get({ owner, repo, issue_number });
      const { data: comments } = await octokit.issues.listComments({ owner, repo, issue_number, per_page: 20 });

      const lines = [
        `#${issue.number} [${issue.state}] ${issue.title}`,
        `Author: ${issue.user?.login ?? 'unknown'} | Created: ${issue.created_at}`,
        `Labels: ${issue.labels.map((l) => typeof l === 'string' ? l : l.name).join(', ') || 'none'}`,
        `Assignees: ${issue.assignees?.map((a) => a.login).join(', ') || 'none'}`,
        `\n--- Body ---\n${truncate(issue.body ?? 'No description')}`,
      ];

      if (comments.length > 0) {
        lines.push(`\n--- Comments (${comments.length}) ---`);
        for (const c of comments) {
          lines.push(`\n${c.user?.login ?? 'unknown'} (${c.created_at}):\n${truncate(c.body ?? '', 2048)}`);
        }
      }

      return ok(lines.join('\n'));
    } catch (e) {
      return err(`Failed to get issue: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

ext.server.tool(
  'github_create_issue',
  'Create a new issue in a repository.',
  { owner: z.string(), repo: z.string(), title: z.string(), body: z.string().optional(), labels: z.array(z.string()).optional(), assignees: z.array(z.string()).optional() },
  // @ts-expect-error — MCP SDK generics cause TS2589
  async ({ owner, repo, title, body, labels, assignees }: { owner: string; repo: string; title: string; body?: string; labels?: string[]; assignees?: string[] }) => {
    try {
      const { data } = await octokit.issues.create({ owner, repo, title, body, labels, assignees });
      return ok(`Created issue #${data.number}: ${data.title}\nURL: ${data.html_url}`);
    } catch (e) {
      return err(`Failed to create issue: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

ext.server.tool(
  'github_add_issue_comment',
  'Add a comment to an existing issue.',
  { owner: z.string(), repo: z.string(), issue_number: z.number(), body: z.string() },
  async ({ owner, repo, issue_number, body }: { owner: string; repo: string; issue_number: number; body: string }) => {
    try {
      const { data } = await octokit.issues.createComment({ owner, repo, issue_number, body });
      return ok(`Comment added to #${issue_number}\nURL: ${data.html_url}`);
    } catch (e) {
      return err(`Failed to add comment: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

// ---------- Pull Request Tools ----------

ext.server.tool(
  'github_list_pulls',
  'List pull requests for a repository. Supports state filter (open/closed/all).',
  { owner: z.string(), repo: z.string(), state: z.enum(['open', 'closed', 'all']).optional(), per_page: z.number().optional() },
  async ({ owner, repo, state, per_page }: { owner: string; repo: string; state?: string; per_page?: number }) => {
    try {
      const { data } = await octokit.pulls.list({
        owner, repo,
        state: (state ?? 'open') as 'open' | 'closed' | 'all',
        per_page: per_page ?? 20,
      });
      if (data.length === 0) return ok('No pull requests found.');
      const lines = data.map((pr) =>
        `#${pr.number} [${pr.state}${pr.draft ? ' DRAFT' : ''}] ${pr.title}\n  ${pr.head.ref} → ${pr.base.ref}\n  Author: ${pr.user?.login ?? 'unknown'} | Created: ${pr.created_at}\n  Reviews: ${pr.requested_reviewers?.map((r) => r.login).join(', ') || 'none requested'}`,
      );
      return ok(lines.join('\n\n'));
    } catch (e) {
      return err(`Failed to list PRs: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

ext.server.tool(
  'github_get_pull',
  'Get details of a specific pull request including diff stats.',
  { owner: z.string(), repo: z.string(), pull_number: z.number() },
  async ({ owner, repo, pull_number }: { owner: string; repo: string; pull_number: number }) => {
    try {
      const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number });
      const { data: files } = await octokit.pulls.listFiles({ owner, repo, pull_number, per_page: 50 });

      const lines = [
        `#${pr.number} [${pr.state}${pr.merged ? ' MERGED' : ''}${pr.draft ? ' DRAFT' : ''}] ${pr.title}`,
        `Author: ${pr.user?.login ?? 'unknown'} | Created: ${pr.created_at}`,
        `${pr.head.ref} → ${pr.base.ref}`,
        `Commits: ${pr.commits} | Changed files: ${pr.changed_files} | +${pr.additions} -${pr.deletions}`,
        `Mergeable: ${pr.mergeable ?? 'unknown'} | Review state: ${pr.mergeable_state ?? 'unknown'}`,
        `\n--- Description ---\n${truncate(pr.body ?? 'No description', 4096)}`,
        `\n--- Changed Files (${files.length}) ---`,
      ];

      for (const f of files) {
        lines.push(`  ${f.status} ${f.filename} (+${f.additions} -${f.deletions})`);
      }

      return ok(lines.join('\n'));
    } catch (e) {
      return err(`Failed to get PR: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

ext.server.tool(
  'github_create_pull',
  'Create a new pull request.',
  { owner: z.string(), repo: z.string(), title: z.string(), head: z.string(), base: z.string(), body: z.string().optional(), draft: z.boolean().optional() },
  // @ts-expect-error — MCP SDK generics cause TS2589
  async ({ owner, repo, title, head, base, body, draft }: { owner: string; repo: string; title: string; head: string; base: string; body?: string; draft?: boolean }) => {
    try {
      const { data } = await octokit.pulls.create({ owner, repo, title, head, base, body, draft });
      return ok(`Created PR #${data.number}: ${data.title}\n${data.head.ref} → ${data.base.ref}\nURL: ${data.html_url}`);
    } catch (e) {
      return err(`Failed to create PR: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

// ---------- Code & File Tools ----------

ext.server.tool(
  'github_get_file',
  'Get the contents of a file from a repository. Specify the path and optionally a branch/ref.',
  { owner: z.string(), repo: z.string(), path: z.string(), ref: z.string().optional() },
  async ({ owner, repo, path, ref }: { owner: string; repo: string; path: string; ref?: string }) => {
    try {
      const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
      if (Array.isArray(data)) {
        // Directory listing
        const entries = data.map((e) => `  ${e.type === 'dir' ? '/' : ''}${e.name}`);
        return ok(`Directory: ${path}\n${entries.join('\n')}`);
      }
      if (data.type !== 'file' || !('content' in data)) {
        return ok(`${path} is a ${data.type} (not a file)`);
      }
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      return ok(`File: ${path} (${data.size} bytes)\n\n${truncate(content)}`);
    } catch (e) {
      return err(`Failed to get file: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

ext.server.tool(
  'github_search_code',
  'Search code across GitHub repositories. Query uses GitHub code search syntax.',
  { query: z.string(), per_page: z.number().optional() },
  async ({ query, per_page }: { query: string; per_page?: number }) => {
    try {
      const { data } = await octokit.search.code({ q: query, per_page: per_page ?? 10 });
      if (data.total_count === 0) return ok('No code matches found.');
      const results = data.items.map((item) =>
        `${item.repository.full_name}/${item.path}\n  URL: ${item.html_url}`,
      );
      return ok(`Found ${data.total_count} matches:\n\n${results.join('\n\n')}`);
    } catch (e) {
      return err(`Code search failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

// ---------- Commit Tools ----------

ext.server.tool(
  'github_list_commits',
  'List recent commits for a repository. Optionally filter by branch/sha and path.',
  { owner: z.string(), repo: z.string(), sha: z.string().optional(), path: z.string().optional(), per_page: z.number().optional() },
  async ({ owner, repo, sha, path, per_page }: { owner: string; repo: string; sha?: string; path?: string; per_page?: number }) => {
    try {
      const { data } = await octokit.repos.listCommits({ owner, repo, sha, path, per_page: per_page ?? 20 });
      const lines = data.map((c) => {
        const msg = c.commit.message.split('\n')[0];
        return `${c.sha.slice(0, 7)} ${msg}\n  Author: ${c.commit.author?.name ?? 'unknown'} | ${c.commit.author?.date ?? ''}`;
      });
      return ok(lines.join('\n\n'));
    } catch (e) {
      return err(`Failed to list commits: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

// ---------- Branch Tools ----------

ext.server.tool(
  'github_list_branches',
  'List branches for a repository.',
  { owner: z.string(), repo: z.string(), per_page: z.number().optional() },
  async ({ owner, repo, per_page }: { owner: string; repo: string; per_page?: number }) => {
    try {
      const { data } = await octokit.repos.listBranches({ owner, repo, per_page: per_page ?? 30 });
      const lines = data.map((b) => `  ${b.protected ? '(protected) ' : ''}${b.name}`);
      return ok(`Branches:\n${lines.join('\n')}`);
    } catch (e) {
      return err(`Failed to list branches: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

// Start the extension
ext.start().catch((e) => {
  console.error('Failed to start GitHub extension:', e);
  process.exit(1);
});

const shutdown = () => ext.shutdown().then(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

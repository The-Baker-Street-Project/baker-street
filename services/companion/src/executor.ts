import { execFile } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger, type CompanionTask, type CompanionTaskResult, type CompanionTaskProgress } from '@bakerst/shared';

const log = logger.child({ module: 'executor' });

export type ProgressCallback = (progress: CompanionTaskProgress) => void;

export async function executeTask(
  companionId: string,
  task: CompanionTask,
  onProgress: ProgressCallback,
): Promise<CompanionTaskResult> {
  const start = Date.now();

  onProgress({
    taskId: task.taskId,
    companionId,
    timestamp: new Date().toISOString(),
    type: 'log',
    message: `Starting task in ${task.mode} mode`,
  });

  try {
    if (task.mode === 'script') {
      return await executeScript(companionId, task, onProgress, start);
    } else {
      return await executeAgent(companionId, task, onProgress, start);
    }
  } catch (err) {
    log.error({ err, taskId: task.taskId }, 'task execution failed');
    return {
      taskId: task.taskId,
      companionId,
      status: 'failed',
      error: String(err),
      durationMs: Date.now() - start,
    };
  }
}

async function executeScript(
  companionId: string,
  task: CompanionTask,
  onProgress: ProgressCallback,
  startMs: number,
): Promise<CompanionTaskResult> {
  // Write script to temp file and execute with execFile
  const scriptPath = join(tmpdir(), `bakerst-task-${randomUUID()}.sh`);
  await writeFile(scriptPath, task.goal, { mode: 0o755 });

  onProgress({
    taskId: task.taskId,
    companionId,
    timestamp: new Date().toISOString(),
    type: 'log',
    message: 'Executing script',
    detail: task.goal,
  });

  return new Promise<CompanionTaskResult>((resolve) => {
    const timeout = (task.timeout ?? 1800) * 1000;
    const child = execFile('/bin/bash', [scriptPath], { timeout }, async (error, stdout, stderr) => {
      // Clean up temp file
      try { await unlink(scriptPath); } catch { /* ignore */ }

      if (error) {
        resolve({
          taskId: task.taskId,
          companionId,
          status: 'failed',
          error: error.message,
          result: stdout + stderr,
          durationMs: Date.now() - startMs,
        });
      } else {
        resolve({
          taskId: task.taskId,
          companionId,
          status: 'completed',
          result: stdout,
          durationMs: Date.now() - startMs,
        });
      }
    });

    // Stream stdout/stderr as progress
    child.stdout?.on('data', (data: Buffer) => {
      onProgress({
        taskId: task.taskId,
        companionId,
        timestamp: new Date().toISOString(),
        type: 'log',
        message: data.toString().trim(),
      });
    });
  });
}

async function executeAgent(
  companionId: string,
  task: CompanionTask,
  onProgress: ProgressCallback,
  startMs: number,
): Promise<CompanionTaskResult> {
  // Agent mode: use Anthropic SDK to reason and act
  // This is a simplified implementation — full agent loop with tools
  // will be built in the toolboxes repo (task runner base image)

  onProgress({
    taskId: task.taskId,
    companionId,
    timestamp: new Date().toISOString(),
    type: 'thinking',
    message: 'Agent mode: processing goal',
    detail: task.goal,
  });

  // Placeholder: in production, this would run an agent loop with local tools
  return {
    taskId: task.taskId,
    companionId,
    status: 'completed',
    result: 'Agent mode not yet implemented in Companion executor. Use script mode.',
    durationMs: Date.now() - startMs,
  };
}

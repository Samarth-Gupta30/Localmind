/*********************************************************************
 * Tool Service – centralised place for all locally-exposed tools.
 *   • Tools are defined in a static whitelist (AVAILABLE_TOOLS).
 *   • Controllers instantiate a ToolService (stateless) and call
 *     `executeTool()` after a one-time approval token has been verified.
 *********************************************************************/

import os from 'os';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

export interface ToolCallRequest {
  name: string;
  arguments: Record<string, unknown>;
}

export class ToolService {
  public static readonly AVAILABLE_TOOLS: ToolDefinition[] = [
    {
      name: 'get_system_specs',
      description:
        'Retrieves live hardware statistics of the local laptop (CPU model, free memory, total RAM, OS uptime). Use when the user asks about system health, RAM, or CPU.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'list_directory_safe',
      description:
        'Lists files and folders inside a specific relative directory within the project workspace.',
      parameters: {
        type: 'object',
        properties: {
          dirPath: {
            type: 'string',
            description:
              'The relative directory path to list (e.g. "." or "data" or "src"). Path traversal outside project root is blocked.',
          },
        },
        required: ['dirPath'],
      },
    },
    {
      name: 'calculate_math',
      description:
        'Evaluates an arithmetic mathematical expression safely (e.g. "128 * 1024" or "(45000 / 12) * 1.18").',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description:
              'The mathematical expression containing numbers and basic operators (+, -, *, /, %).',
          },
        },
        required: ['expression'],
      },
    },
    {
      name: 'get_current_time',
      description:
        'Returns the current local system date, day of the week, time, and timezone. Use when the user asks for the current date or time.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  ];

  public async executeTool(call: ToolCallRequest): Promise<any> {
    logger.info('ToolSandbox', `Executing approved tool: ${call.name}`);

    switch (call.name) {
      case 'get_system_specs':
        return this.getSystemSpecs();

      case 'list_directory_safe':
        return this.listDirectorySafe((call.arguments as any).dirPath ?? '.');

      case 'calculate_math':
        return this.calculateMath((call.arguments as any).expression);

      case 'get_current_time':
        return this.getCurrentTime();

      default:
        throw new Error(`Security Exception: Tool '${call.name}' is not in the allowed whitelist.`);
    }
  }

  private getSystemSpecs() {
    const totalRamGB = (os.totalmem() / (1024 * 1024 * 1024)).toFixed(2);
    const freeRamGB = (os.freemem() / (1024 * 1024 * 1024)).toFixed(2);
    const usedRamGB = (Number(totalRamGB) - Number(freeRamGB)).toFixed(2);
    const cpus = os.cpus();

    return {
      osType: os.type(),
      platform: os.platform(),
      cpuModel: cpus[0]?.model || 'Unknown CPU',
      cpuCores: cpus.length,
      totalMemory: `${totalRamGB} GB`,
      freeMemory: `${freeRamGB} GB`,
      usedMemory: `${usedRamGB} GB`,
      uptimeHours: (os.uptime() / 3600).toFixed(1),
    };
  }

  /** Safe directory listing – prevents traversal and symlink escapes */
  private listDirectorySafe(relPath: string) {
    if (typeof relPath !== 'string') {
      throw new Error('Directory path must be a string.');
    }

    if (relPath.includes('\0')) {
      throw new Error('Security Violation: Null byte detected in path.');
    }

    const trimmed = relPath.trim() || '.';
    const canonicalRoot = fs.realpathSync(process.cwd());
    const lexicalTarget = path.resolve(canonicalRoot, trimmed);
    const relativeLexical = path.relative(canonicalRoot, lexicalTarget);

    if (
      relativeLexical === '..' ||
      relativeLexical.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeLexical)
    ) {
      throw new Error(
        'Security Violation: Path traversal outside project root is forbidden.'
      );
    }

    const components = relativeLexical
      ? relativeLexical.split(path.sep).filter(Boolean)
      : [];

    let currentPath = canonicalRoot;

  for (const component of components) {
      currentPath = path.join(currentPath, component);

      let stats: fs.Stats;
      try {
        stats = fs.lstatSync(currentPath);
      } catch (err: any) {
        if (err?.code === 'ENOENT') {
          throw new Error(`Directory '${trimmed}' does not exist.`);
        }
        throw err;
      }

      if (stats.isSymbolicLink()) {
        throw new Error(
          'Security Violation: Symbolic links are not allowed in requested paths.'
        );
      }
    }  

    const canonicalTarget = fs.realpathSync(lexicalTarget);

    const isInsideRoot =
      canonicalTarget === canonicalRoot ||
      canonicalTarget.startsWith(canonicalRoot + path.sep);

    if (!isInsideRoot) {
      throw new Error(
        'Security Violation: Target path points outside the project workspace.'
      );
    }

    const targetStats = fs.lstatSync(lexicalTarget);

    if (targetStats.isSymbolicLink()) {
      throw new Error(
        'Security Violation: Symbolic link directories are not allowed.'
      );
    }

    if (!targetStats.isDirectory()) {
      throw new Error(`'${trimmed}' is not a directory.`);
    }

    const entries = fs.readdirSync(canonicalTarget, {
      withFileTypes: true,
    });

    const SENSITIVE_PATTERNS = new Set(['.env', '.git', 'node_modules']);

    return entries
      .filter((entry) => !SENSITIVE_PATTERNS.has(entry.name))
      .map((entry) => {
        const fullPath = path.join(canonicalTarget, entry.name);

        let isDirectory = false;
        let isSymlink = entry.isSymbolicLink();
        let sizeBytes: number | null = null;

        try {
          const stats = fs.lstatSync(fullPath);
          isSymlink = stats.isSymbolicLink();

          if (!isSymlink) {
            isDirectory = stats.isDirectory();
            if (stats.isFile()) {
              sizeBytes = stats.size;
            }
          }
        } catch {
          sizeBytes = null;
        }

        return {
          name: entry.name,
          isDirectory,
          isSymlink,
          sizeBytes,
        };
      });
  }

  private getCurrentTime() {
    const now = new Date();
    const timezone = 'Asia/Kolkata';

    return {
      success: true,
      day: now.toLocaleDateString('en-IN', {
        weekday: 'long',
        timeZone: timezone,
      }),
      date: now.toLocaleDateString('en-IN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: timezone,
      }),
      time: now.toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        timeZone: timezone,
      }),
      timezone,
      iso: now.toISOString(),
    };
  }

  private calculateMath(expression: string) {
    if (typeof expression !== 'string' || !/^[0-9+\-*/().% \t]+$/.test(expression)) {
      throw new Error('Invalid mathematical expression. Only basic arithmetic operators are allowed.');
    }

    try {
      const result = Function(`"use strict"; return (${expression})`)();

      if (typeof result !== 'number' || !Number.isFinite(result)) {
        throw new Error('Result must be a finite number.');
      }

      return { expression, result };
    } catch (err: unknown) {
      throw new Error(
        `Calculation error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
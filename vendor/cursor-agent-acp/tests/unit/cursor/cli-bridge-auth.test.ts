/**
 * Unit tests for CursorCliBridge authentication status parsing
 *
 * Tests the parsing of cursor-agent status output with ANSI codes
 * and different authentication response formats.
 */

import { EventEmitter } from 'events';
import { jest } from '@jest/globals';
import { spawn } from 'child_process';
import { CursorCliBridge } from '../../../src/cursor/cli-bridge';
import type { AdapterConfig, Logger, CursorResponse } from '../../../src/types';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

describe('CursorCliBridge - Authentication Status Parsing', () => {
  let bridge: CursorCliBridge;
  let mockConfig: AdapterConfig;
  let mockLogger: Logger;
  const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

  beforeEach(() => {
    mockConfig = {
      logLevel: 'error',
      sessionDir: '/tmp/test-sessions',
      maxSessions: 10,
      sessionTimeout: 3600,
      tools: {
        filesystem: { enabled: true },
        terminal: { enabled: true, maxProcesses: 5 },
        cursor: {
          enabled: true,
          maxSearchResults: 50,
          enableCodeModification: true,
          enableTestExecution: true,
        },
      },
      cursor: {
        timeout: 30000,
        retries: 3,
      },
    };

    mockLogger = {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    };

    bridge = new CursorCliBridge(mockConfig, mockLogger);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  describe('checkAuthentication', () => {
    test('should parse "Logged in as" format with ANSI codes', async () => {
      // Mock executeCommand to return actual cursor-agent status output with ANSI codes
      const mockOutput =
        ' Starting login process...\n\n[2K[1A[2K[1A[2K[GChecking authentication status...\n[2K[1A[2K[G\n ✓ Logged in as mike.moore@fluid.app\n\n';

      jest.spyOn(bridge as any, 'executeCommand').mockResolvedValue({
        success: true,
        stdout: mockOutput,
        stderr: '',
        exitCode: 0,
      } as CursorResponse);

      const result = await bridge.checkAuthentication();

      expect(result.authenticated).toBe(true);
      expect(result.email).toBe('mike.moore@fluid.app');
    });

    test('should parse "Signed in as" format', async () => {
      const mockOutput = '✓ Signed in as user@example.com';

      jest.spyOn(bridge as any, 'executeCommand').mockResolvedValue({
        success: true,
        stdout: mockOutput,
        stderr: '',
        exitCode: 0,
      } as CursorResponse);

      const result = await bridge.checkAuthentication();

      expect(result.authenticated).toBe(true);
      expect(result.email).toBe('user@example.com');
    });

    test('should parse traditional "User:" format', async () => {
      const mockOutput = 'User: testuser\nEmail: test@example.com\nPlan: pro';

      jest.spyOn(bridge as any, 'executeCommand').mockResolvedValue({
        success: true,
        stdout: mockOutput,
        stderr: '',
        exitCode: 0,
      } as CursorResponse);

      const result = await bridge.checkAuthentication();

      expect(result.authenticated).toBe(true);
      expect(result.user).toBe('testuser');
      expect(result.email).toBe('test@example.com');
      expect(result.plan).toBe('pro');
    });

    test('should handle username (non-email) in "Logged in as" format', async () => {
      const mockOutput = 'Logged in as john_doe';

      jest.spyOn(bridge as any, 'executeCommand').mockResolvedValue({
        success: true,
        stdout: mockOutput,
        stderr: '',
        exitCode: 0,
      } as CursorResponse);

      const result = await bridge.checkAuthentication();

      expect(result.authenticated).toBe(true);
      expect(result.user).toBe('john_doe');
      expect(result.email).toBeUndefined();
    });

    test('should properly strip ANSI escape codes', async () => {
      // Multiple types of ANSI codes
      const mockOutput =
        '\x1B[32m✓\x1B[0m \x1B[1mLogged in as\x1B[0m test@example.com\x1B[2K\x1B[1A';

      jest.spyOn(bridge as any, 'executeCommand').mockResolvedValue({
        success: true,
        stdout: mockOutput,
        stderr: '',
        exitCode: 0,
      } as CursorResponse);

      const result = await bridge.checkAuthentication();

      expect(result.authenticated).toBe(true);
      expect(result.email).toBe('test@example.com');
    });

    test('should return not authenticated when no user info found', async () => {
      const mockOutput = 'Some other output without auth info';

      jest.spyOn(bridge as any, 'executeCommand').mockResolvedValue({
        success: true,
        stdout: mockOutput,
        stderr: '',
        exitCode: 0,
      } as CursorResponse);

      const result = await bridge.checkAuthentication();

      expect(result.authenticated).toBe(false);
    });

    test('should handle failed executeCommand', async () => {
      jest.spyOn(bridge as any, 'executeCommand').mockResolvedValue({
        success: false,
        stdout: '',
        stderr: 'Not logged in',
        exitCode: 1,
        error: 'Not logged in',
      } as CursorResponse);

      const result = await bridge.checkAuthentication();

      expect(result.authenticated).toBe(false);
      expect(result.error).toBe('Not logged in');
    });

    test('should handle executeCommand throwing error', async () => {
      jest
        .spyOn(bridge as any, 'executeCommand')
        .mockRejectedValue(new Error('Connection failed'));

      const result = await bridge.checkAuthentication();

      expect(result.authenticated).toBe(false);
      expect(result.error).toBe('Connection failed');
    });

    test('should handle case-insensitive "logged in" matching', async () => {
      const mockOutput = 'LOGGED IN AS admin@company.com';

      jest.spyOn(bridge as any, 'executeCommand').mockResolvedValue({
        success: true,
        stdout: mockOutput,
        stderr: '',
        exitCode: 0,
      } as CursorResponse);

      const result = await bridge.checkAuthentication();

      expect(result.authenticated).toBe(true);
      expect(result.email).toBe('admin@company.com');
    });

    test('should handle mixed format (traditional + new)', async () => {
      // If both formats exist, should capture all available info
      const mockOutput = 'Logged in as user@example.com\nPlan: enterprise';

      jest.spyOn(bridge as any, 'executeCommand').mockResolvedValue({
        success: true,
        stdout: mockOutput,
        stderr: '',
        exitCode: 0,
      } as CursorResponse);

      const result = await bridge.checkAuthentication();

      expect(result.authenticated).toBe(true);
      expect(result.email).toBe('user@example.com');
      expect(result.plan).toBe('enterprise');
    });

    test('should handle empty stdout', async () => {
      jest.spyOn(bridge as any, 'executeCommand').mockResolvedValue({
        success: true,
        stdout: '',
        stderr: '',
        exitCode: 0,
      } as CursorResponse);

      const result = await bridge.checkAuthentication();

      expect(result.authenticated).toBe(false);
    });

    test('should handle multiline output with ANSI codes', async () => {
      const mockOutput = [
        '\x1B[2KChecking...',
        '\x1B[1A\x1B[2K',
        '✓ Logged in as developer@company.com',
        '\x1B[G',
      ].join('\n');

      jest.spyOn(bridge as any, 'executeCommand').mockResolvedValue({
        success: true,
        stdout: mockOutput,
        stderr: '',
        exitCode: 0,
      } as CursorResponse);

      const result = await bridge.checkAuthentication();

      expect(result.authenticated).toBe(true);
      expect(result.email).toBe('developer@company.com');
    });
  });

  describe('streaming timeout', () => {
    function createMockChildProcess() {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        killed: boolean;
        kill: jest.Mock<boolean, [NodeJS.Signals?]>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.killed = false;
      child.kill = jest.fn((_: NodeJS.Signals | undefined) => {
        child.killed = true;
        return true;
      });
      return child;
    }

    test('should refresh streaming timeout whenever stdout data arrives', async () => {
      jest.useFakeTimers();
      const child = createMockChildProcess();
      mockSpawn.mockReturnValue(child as any);

      const promise = (bridge as any).executeStreamingCommand(['agent'], {
        onData: jest.fn().mockResolvedValue(undefined),
      });

      await jest.advanceTimersByTimeAsync(20_000);
      child.stdout.emit('data', Buffer.from('chunk-1'));
      await Promise.resolve();

      await jest.advanceTimersByTimeAsync(20_000);
      child.stdout.emit('data', Buffer.from('chunk-2'));
      await Promise.resolve();

      await jest.advanceTimersByTimeAsync(20_000);
      expect(child.kill).not.toHaveBeenCalled();

      child.emit('close', 0);
      await expect(promise).resolves.toMatchObject({
        success: true,
        stdout: 'chunk-1chunk-2',
      });
    });

    test('should timeout when streaming becomes idle for longer than configured timeout', async () => {
      jest.useFakeTimers();
      const child = createMockChildProcess();
      mockSpawn.mockReturnValue(child as any);

      const promise = (bridge as any).executeStreamingCommand(['agent'], {
        onData: jest.fn().mockResolvedValue(undefined),
      });

      child.stdout.emit('data', Buffer.from('chunk-1'));
      await Promise.resolve();

      await jest.advanceTimersByTimeAsync(29_000);
      expect(child.kill).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1_001);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      await expect(promise).rejects.toThrow('Streaming command timed out');
    });
  });
});

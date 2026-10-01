/**
 * Minimal Windows minidump (.dmp) reader.
 *
 * When an Electron app dies natively, the *only* trustworthy evidence is the dump
 * Windows writes. This module extracts the exception record, the module that
 * contains the faulting address, and the loaded-module list, so a crash can be
 * reported as `ACCESS_VIOLATION in electron.exe+0x7d1315b` instead of a bare exit
 * code - and so an injected third-party DLL is visible immediately.
 *
 * Format reference: MINIDUMP_HEADER, MINIDUMP_DIRECTORY, MINIDUMP_MODULE,
 * MINIDUMP_EXCEPTION_STREAM, MINIDUMP_SYSTEM_INFO.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const EXCEPTION_NAMES = {
  0xc0000005: 'ACCESS_VIOLATION',
  0x80000003: 'STATUS_BREAKPOINT',
  0xc000001d: 'ILLEGAL_INSTRUCTION',
  0xc0000094: 'INTEGER_DIVIDE_BY_ZERO',
  0xc00000fd: 'STACK_OVERFLOW',
  0xc0000409: 'STACK_BUFFER_OVERRUN',
  0xc0000374: 'HEAP_CORRUPTION',
  0x80000002: 'DATATYPE_MISALIGNMENT',
  0xc0000135: 'DLL_NOT_FOUND',
  0xc0000142: 'DLL_INIT_FAILED',
  0xe06d7363: 'CPP_EXCEPTION',
};

const STREAM = { MODULE_LIST: 4, EXCEPTION: 6, SYSTEM_INFO: 7 };

function readString(buffer, rva) {
  const length = buffer.readUInt32LE(rva);
  return buffer.toString('utf16le', rva + 4, rva + 4 + length);
}

/** Parse a minidump buffer into `{ exception, modules, system }`. */
export function parseMinidumpBuffer(buffer, source = '<buffer>') {
  if (buffer.toString('latin1', 0, 4) !== 'MDMP') {
    throw new Error(`${source} is not a minidump (missing MDMP signature)`);
  }
  const numberOfStreams = buffer.readUInt32LE(8);
  const directoryRva = buffer.readUInt32LE(12);

  const streams = new Map();
  for (let i = 0; i < numberOfStreams; i++) {
    const entry = directoryRva + i * 12;
    streams.set(buffer.readUInt32LE(entry), { size: buffer.readUInt32LE(entry + 4), rva: buffer.readUInt32LE(entry + 8) });
  }

  const result = { source, exception: null, modules: [], system: null };

  const moduleStream = streams.get(STREAM.MODULE_LIST);
  if (moduleStream !== undefined) {
    const count = buffer.readUInt32LE(moduleStream.rva);
    for (let i = 0; i < count; i++) {
      const base = moduleStream.rva + 4 + i * 108;
      result.modules.push({
        name: readString(buffer, buffer.readUInt32LE(base + 20)),
        baseAddress: buffer.readBigUInt64LE(base),
        sizeOfImage: buffer.readUInt32LE(base + 8),
        timeDateStamp: buffer.readUInt32LE(base + 12),
      });
    }
  }

  const exceptionStream = streams.get(STREAM.EXCEPTION);
  if (exceptionStream !== undefined) {
    const record = exceptionStream.rva + 8;
    const code = buffer.readUInt32LE(record) >>> 0;
    const numberParameters = buffer.readUInt32LE(record + 24);
    const parameters = [];
    for (let i = 0; i < Math.min(numberParameters, 15); i++) {
      parameters.push(buffer.readBigUInt64LE(record + 32 + i * 8));
    }
    result.exception = {
      code,
      name: EXCEPTION_NAMES[code] ?? `0x${code.toString(16)}`,
      address: buffer.readBigUInt64LE(record + 16),
      parameters,
    };
  }

  const systemStream = streams.get(STREAM.SYSTEM_INFO);
  if (systemStream !== undefined) {
    const rva = systemStream.rva;
    result.system = {
      numberOfProcessors: buffer.readUInt8(rva + 6),
      version: `${buffer.readUInt32LE(rva + 8)}.${buffer.readUInt32LE(rva + 12)}.${buffer.readUInt32LE(rva + 16)}`,
    };
  }
  return result;
}

/** Identify which loaded module contains `address`. */
export function attributeAddress(minidump, address) {
  for (const module of minidump.modules) {
    if (address >= module.baseAddress && address < module.baseAddress + BigInt(module.sizeOfImage)) {
      return { ...module, offset: address - module.baseAddress };
    }
  }
  return null;
}

/** Parse a dump file and describe the crash in report-ready form. */
export async function analyseDump(path) {
  const minidump = parseMinidumpBuffer(await readFile(path), path);
  const attributed = minidump.exception ? attributeAddress(minidump, minidump.exception.address) : null;
  const systemModules = minidump.modules.filter((m) => /[\\/]Windows[\\/]/i.test(m.name)).length;
  return {
    dump: path,
    system: minidump.system,
    exception: minidump.exception
      ? {
          name: minidump.exception.name,
          code: `0x${minidump.exception.code.toString(16)}`,
          address: `0x${minidump.exception.address.toString(16)}`,
          parameters: minidump.exception.parameters.map((p) => `0x${p.toString(16)}`),
          module: attributed?.name ?? '(unmapped)',
          moduleOffset: attributed ? `0x${attributed.offset.toString(16)}` : null,
          /** Non-system modules are the interesting ones: injected AV/overlays. */
          foreignModule: attributed && !/[\\/]Windows[\\/]/i.test(attributed.name) ? attributed.name : null,
        }
      : null,
    moduleCount: minidump.modules.length,
    systemModuleCount: systemModules,
    nonSystemModules: minidump.modules.filter((m) => !/[\\/]Windows[\\/]/i.test(m.name)).map((m) => m.name),
  };
}

/**
 * Find and analyse the newest crash dumps for a binary name.
 * Returns [] when the platform or directory has none.
 */
export async function recentCrashDumps(binaryName, { limit = 5, since = null, directories = null } = {}) {
  const dirs = directories ?? [process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'CrashDumps') : null].filter(Boolean);
  const found = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().startsWith(`${binaryName.toLowerCase()}.`)) continue;
      if (!entry.name.toLowerCase().endsWith('.dmp')) continue;
      const path = join(dir, entry.name);
      const { stat } = await import('node:fs/promises');
      const info = await stat(path).catch(() => null);
      if (!info) continue;
      if (since && info.mtimeMs < since) continue;
      found.push({ path, mtimeMs: info.mtimeMs, size: info.size });
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const analysed = [];
  for (const candidate of found.slice(0, limit)) {
    try {
      analysed.push(await analyseDump(candidate.path));
    } catch (error) {
      analysed.push({ dump: candidate.path, error: error.message });
    }
  }
  return analysed;
}

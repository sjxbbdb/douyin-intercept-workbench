'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function checksum(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

class JsonStore {
  constructor(filePath, initialValue) {
    this.filePath = filePath;
    this.initialValue = initialValue;
    const loaded = this.#read();
    this.value = loaded.value;
    this.revision = loaded.revision;
    this.recoveryRequired = loaded.recoveryRequired;
  }

  #read() {
    const directory = path.dirname(this.filePath);
    const basename = path.basename(this.filePath);
    const candidates = [{ path: this.filePath, isPrimary: true }];
    try {
      for (const entry of fs.readdirSync(directory)) if (entry.startsWith(`${basename}.v-`)) candidates.push({ path: path.join(directory, entry), isPrimary: false });
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`本地数据目录不可读：${directory}；${error.message}`);
    }
    const valid = [];
    let primaryError = null;
    let invalidVersion = false;
    let highestInvalidRevision = null;
    let unknownInvalidVersion = false;
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate.path, 'utf8'));
        const declaredRevision = parsed && Number.isInteger(parsed.revision) && parsed.revision > 0 ? parsed.revision : null;
        if (parsed && parsed.format === 1) {
          if (Number.isInteger(parsed.revision) && parsed.revision > 0 && parsed.value !== undefined && parsed.checksum === checksum(parsed.value)) {
            valid.push({ value: parsed.value, revision: parsed.revision, isPrimary: candidate.isPrimary });
          } else {
            throw Object.assign(new Error('版本记录校验失败'), { recordRevision: declaredRevision });
          }
        } else if (candidate.isPrimary && parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !Object.prototype.hasOwnProperty.call(parsed, 'format')) {
          valid.push({ value: parsed, revision: 0, isPrimary: true });
        } else if (!candidate.isPrimary) {
          throw Object.assign(new Error('版本记录校验失败'), { recordRevision: declaredRevision });
        } else {
          throw new Error('主记录格式无效');
        }
      } catch (error) {
        if (candidate.isPrimary) {
          if (error.code !== 'ENOENT') primaryError = error;
        } else {
          invalidVersion = true;
          const filenameRevision = candidate.path.match(/\.v-(\d+)-/)?.[1];
          const revision = Number.isInteger(error.recordRevision) ? error.recordRevision : (filenameRevision ? Number(filenameRevision) : null);
          if (Number.isInteger(revision) && revision > 0) highestInvalidRevision = highestInvalidRevision == null ? revision : Math.max(highestInvalidRevision, revision);
          else unknownInvalidVersion = true;
        }
      }
    }
    if (!valid.length) {
      if (primaryError || invalidVersion) throw new Error(`本地数据存储损坏或不可读：${this.filePath}；${primaryError?.message || '没有可验证的版本记录'}`);
      return { value: typeof this.initialValue === 'function' ? this.initialValue() : structuredClone(this.initialValue), revision: 0, recoveryRequired: false };
    }
    valid.sort((left, right) => right.revision - left.revision || Number(right.isPrimary) - Number(left.isPrimary));
    const selected = valid[0];
    const primaryBroken = Boolean(primaryError && !valid.some((candidate) => candidate.isPrimary));
    const damagedNewer = invalidVersion && (unknownInvalidVersion || (highestInvalidRevision != null && highestInvalidRevision >= selected.revision));
    return { value: selected.value, revision: selected.revision, recoveryRequired: primaryBroken || damagedNewer };
  }

  get() { return structuredClone(this.value); }

  set(nextValue) {
    const next = structuredClone(nextValue);
    const nextRevision = this.revision + 1;
    this.#flushValue(next, nextRevision);
    this.value = next;
    this.revision = nextRevision;
    this.recoveryRequired = false;
    return this.get();
  }

  update(mutator) { return this.set(mutator(this.get())); }

  flush() { this.#flushValue(this.value, this.revision + 1); this.revision += 1; this.recoveryRequired = false; }

  #flushValue(value, revision) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    const payload = { format: 1, revision, checksum: checksum(value), value };
    let handle;
    try {
      handle = fs.openSync(tempPath, 'wx', 0o600);
      fs.writeFileSync(handle, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8' });
      fs.fsyncSync(handle);
      fs.closeSync(handle);
      handle = undefined;
      try {
        fs.renameSync(tempPath, this.filePath);
      } catch (renameError) {
        if (renameError.code !== 'EXDEV') throw renameError;
        const versionPath = `${this.filePath}.v-${revision}-${process.pid}-${Date.now()}`;
        let versionHandle;
        try {
          versionHandle = fs.openSync(versionPath, 'wx', 0o600);
          fs.writeFileSync(versionHandle, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8' });
          fs.fsyncSync(versionHandle);
          fs.closeSync(versionHandle);
          versionHandle = undefined;
          fs.rmSync(tempPath, { force: true });
          this.#pruneVersions();
        } catch (versionError) {
          if (versionHandle !== undefined) { try { fs.closeSync(versionHandle); } catch (closeError) { console.warn('[json-store] version close failed', closeError.message); } }
          throw versionError;
        }
      }
    } catch (error) {
      if (handle !== undefined) { try { fs.closeSync(handle); } catch (closeError) { console.warn('[json-store] temp close failed', closeError.message); } }
      try { fs.rmSync(tempPath, { force: true }); } catch (cleanupError) { console.warn('[json-store] temp cleanup failed', cleanupError.message); }
      throw error;
    }
  }

  #pruneVersions() {
    const directory = path.dirname(this.filePath);
    const basename = path.basename(this.filePath);
    const versions = fs.readdirSync(directory).filter((entry) => entry.startsWith(`${basename}.v-`)).map((entry) => {
      const match = entry.match(/\.v-(\d+)-/);
      return { entry, path: path.join(directory, entry), revision: match ? Number(match[1]) : -1 };
    }).sort((left, right) => right.revision - left.revision || left.entry.localeCompare(right.entry));
    for (const item of versions.slice(4)) { try { fs.rmSync(item.path, { force: true }); } catch (error) { console.warn('[json-store] version prune failed', error.message); } }
  }
}

module.exports = { JsonStore, checksum };

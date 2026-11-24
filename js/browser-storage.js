// Shared browser-storage policy for existing settings. A setting gets its normal
// write first. Only when saved command history is the value preventing that
// write do we yield the durable list and retry once; active terminal history is
// closure-owned elsewhere and is never changed here.
const ROOTVC_HISTORY_STORAGE_KEY = "rootvc.history.v1";
const ROOTVC_EMPTY_HISTORY = "[]";
const _settingRecoveryOwners = new WeakMap();

function _hasYieldableHistory(serialized) {
  if (serialized === null || serialized === ROOTVC_EMPTY_HISTORY) return false;

  try {
    const entries = JSON.parse(serialized);
    return (
      Array.isArray(entries) &&
      entries.length > 0 &&
      entries.every((entry) => typeof entry === "string")
    );
  } catch (_) {
    return false;
  }
}

function writeBrowserSetting(storage, targetKey, serializedCandidate) {
  try {
    storage.setItem(targetKey, serializedCandidate);
    return;
  } catch (originalError) {
    const errorName = originalError?.name;
    if (
      errorName !== "QuotaExceededError" &&
      errorName !== "NS_ERROR_DOM_QUOTA_REACHED"
    ) {
      throw originalError;
    }

    let originalHistory;
    try {
      originalHistory = storage.getItem(ROOTVC_HISTORY_STORAGE_KEY);
    } catch (_) {
      throw originalError;
    }

    if (!_hasYieldableHistory(originalHistory)) throw originalError;

    // Release all history bytes so a setting that exactly fits can succeed.
    // Older Storage-compatible seams may not expose removeItem; an empty
    // string is the equivalent zero-byte tombstone and restores as empty.
    const recoveryOwner = {};
    _settingRecoveryOwners.set(storage, recoveryOwner);
    const canRemove = typeof storage.removeItem === "function";
    const yieldedHistory = canRemove ? null : "";
    try {
      if (canRemove) storage.removeItem(ROOTVC_HISTORY_STORAGE_KEY);
      else storage.setItem(ROOTVC_HISTORY_STORAGE_KEY, yieldedHistory);
    } catch (_) {
      throw originalError;
    }

    try {
      storage.setItem(targetKey, serializedCandidate);
      return;
    } catch (_) {
      // Restore only while this recovery still owns the temporary empty value.
      // A newer history writer must never be replaced by stale bytes.
      try {
        if (
          _settingRecoveryOwners.get(storage) === recoveryOwner &&
          storage.getItem(ROOTVC_HISTORY_STORAGE_KEY) === yieldedHistory
        ) {
          storage.setItem(ROOTVC_HISTORY_STORAGE_KEY, originalHistory);
        }
      } catch (_) {
        // Rollback is best effort; preserve the setting caller's original error.
      }
      throw originalError;
    }
  }
}

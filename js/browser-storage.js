// Shared browser-storage policy for existing settings. A setting gets its normal
// write first. Only when saved command history is the value preventing that
// write do we yield the durable list and retry once; active terminal history is
// closure-owned elsewhere and is never changed here.
const ROOTVC_HISTORY_STORAGE_KEY = "rootvc.history.v1";
const ROOTVC_EMPTY_HISTORY = "[]";

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
    let originalHistory;
    try {
      originalHistory = storage.getItem(ROOTVC_HISTORY_STORAGE_KEY);
    } catch (_) {
      throw originalError;
    }

    if (!_hasYieldableHistory(originalHistory)) throw originalError;

    try {
      storage.setItem(ROOTVC_HISTORY_STORAGE_KEY, ROOTVC_EMPTY_HISTORY);
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
        if (storage.getItem(ROOTVC_HISTORY_STORAGE_KEY) === ROOTVC_EMPTY_HISTORY) {
          storage.setItem(ROOTVC_HISTORY_STORAGE_KEY, originalHistory);
        }
      } catch (_) {
        // Rollback is best effort; preserve the setting caller's original error.
      }
      throw originalError;
    }
  }
}

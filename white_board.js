/**
 * Fairy Tails Staff Board - Google Apps Script Backend
 * 
 * This script provides a web API for the Staff Board website to:
 * - Load board data (Today and Tomorrow)
 * - Save board changes
 * - Transfer Tomorrow to Today
 * - Manage van times
 * 
 * Deploy as: Web App (Execute as: Me, Access: Anyone)
 * 
 * Data is populated by n8n workflow from Acuity Scheduling daily at 2:05 PM
 * 
 * UPDATED: Now uses VP_AM and VP_PM columns for morning/evening pickup
 */

// =====================
// CONFIGURATION
// =====================

// Sheet tab names
const TABS = {
  TODAY: 'Today',
  TOMORROW: 'Tomorrow',
  SETTINGS: 'Settings',
  IMPORT_LOG: 'Import_Log'
};

// Column headers for board tabs (must match Google Sheet)
// Sheet structure: ID | Dog_Name | Photo | Walk | Stop_AM | VP_AM | VP_PM | Stop | Notes | Acuity_ID | Appointment_Type | Crate | Pickup | Dropoff | Van_Type | Check_In | Check_Out | Crate_Size | Behaviour | Is_Grooming
const BOARD_HEADERS = ['ID', 'Dog_Name', 'Photo', 'Walk', 'Stop_AM', 'VP_AM', 'VP_PM', 'Stop', 'Notes', 'Acuity_ID', 'Appointment_Type', 'Crate', 'Pickup', 'Dropoff', 'Van_Type', 'Check_In', 'Check_Out', 'Crate_Size', 'Behaviour', 'Is_Grooming'];

// Column indices (0-based) for easier reference
const COLS = {
  ID: 0,
  DOG_NAME: 1,
  PHOTO: 2,
  WALK: 3,
  STOP_AM: 4,
  VP_AM: 5,
  VP_PM: 6,
  STOP: 7,
  NOTES: 8,
  ACUITY_ID: 9,
  APPOINTMENT_TYPE: 10,
  CRATE: 11,
  // Grooming Dogs columns
  PICKUP: 12,
  DROPOFF: 13,
  VAN_TYPE: 14,
  // Boarding School columns
  CHECK_IN: 15,
  CHECK_OUT: 16,
  CRATE_SIZE: 17,
  // Behaviour marker (1-5)
  BEHAVIOUR: 18,
  // Grooming-dog marker (TRUE/FALSE). Additive last column (2026-06-01) — set
  // by updateVanRoute when n8n sends a route carrying a grooming (G.D.) dog,
  // and read by the front-end to show a ✂️ (grooming) badge.
  IS_GROOMING: 19
};

// =====================
// WEB APP ENTRY POINTS
// =====================

/**
 * Handle GET requests - Load data
 */
function doGet(e) {
  try {
    const action = e.parameter.action || 'load';
    
    let result;
    
    switch (action) {
      case 'load':
        result = loadAllData();
        break;
      case 'loadToday':
        result = loadBoardData(TABS.TODAY);
        break;
      case 'loadTomorrow':
        // Heal any stray AM "V" on the Tomorrow tab before serving (AM only).
        resolveTomorrowVansFailsafe_();
        result = loadBoardData(TABS.TOMORROW);
        break;
      case 'resolveTodayVans':
        // On-demand fail-safe sweep of the Today tab (force = bypass throttle).
        result = resolveTodayVansFailsafe_(true);
        break;
      case 'resolveTomorrowVans':
        // On-demand fail-safe sweep of the Tomorrow tab AM column (force = bypass throttle).
        result = resolveTomorrowVansFailsafe_(true);
        break;
      case 'loadVanTimes':
        result = loadVanTimes();
        break;
      default:
        result = { error: 'Unknown action: ' + action };
    }

    return createJsonResponse(result);

  } catch (error) {
    return createJsonResponse({ error: error.message });
  }
}

/**
 * Handle POST requests - Save data
 */
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const action = data.action || 'save';
    
    let result;
    
    switch (action) {
      case 'save':
        result = saveAllData(data);
        break;
      case 'saveToday':
        result = saveBoardData(TABS.TODAY, data.dogs, { preserveRouteColumns: true, blockEmptyOverwrite: !data.allowEmpty });
        break;
      case 'saveTomorrow':
        result = saveBoardData(TABS.TOMORROW, data.dogs, { preserveRouteColumns: true, blockEmptyOverwrite: !data.allowEmpty });
        break;
      case 'saveVanTimes':
        result = saveVanTimes(data.vanTimes);
        break;
      case 'transfer':
        result = transferTomorrowToToday();
        break;
      case 'resolveTodayVans':
        // On-demand fail-safe sweep of the Today tab (force = bypass throttle).
        result = resolveTodayVansFailsafe_(true);
        break;
      case 'resolveTomorrowVans':
        // On-demand fail-safe sweep of the Tomorrow tab AM column (force = bypass throttle).
        result = resolveTomorrowVansFailsafe_(true);
        break;
      case 'updateRoute':
        result = updateVanRoute(data);
        break;
      case 'clearTomorrow':
        result = clearBoard(TABS.TOMORROW);
        break;
      default:
        result = { error: 'Unknown action: ' + action };
    }
    
    return createJsonResponse(result);
    
  } catch (error) {
    return createJsonResponse({ error: error.message });
  }
}

// =====================
// DATA OPERATIONS
// =====================

/**
 * Load all data (Today, Tomorrow, Van Times)
 */
function loadAllData() {
  // FAIL-SAFE (last resort, ADDED 2026-06-03): before serving the board, heal any
  // stray "V" left on the Today tab's VP_AM/VP_PM by resolving it to the dog's
  // real BV/SV/DV from the van roster. Covers a "V" that slipped past BOTH the
  // n8n import AND the transfer-time net. Cheap + throttled, never throws — see
  // resolveTodayVansFailsafe_. The loadBoardData(TODAY) read below then reflects
  // any cell it just healed.
  resolveTodayVansFailsafe_();

  // FAIL-SAFE (ADDED 2026-06-04): same idea for the Tomorrow tab, but AM ONLY —
  // heal any VP_AM still on "V" to the dog's BV/SV/DV from the roster. VP_PM is
  // deliberately left alone on Tomorrow (PM is resolved at the Tomorrow→Today
  // transfer). Cheap + throttled, never throws — see resolveTomorrowVansFailsafe_.
  // The loadBoardData(TOMORROW) read below then reflects any cell it just healed.
  resolveTomorrowVansFailsafe_();

  const today = loadBoardData(TABS.TODAY);
  const tomorrow = loadBoardData(TABS.TOMORROW);
  const vanTimes = loadVanTimes();
  
  return {
    success: true,
    data: {
      today: {
        dogs: today.dogs || [],
        staging: [],
        vanTimes: vanTimes.data?.today || { BV: '07:30', DV: '08:00', SV: '08:30' }
      },
      tomorrow: {
        dogs: tomorrow.dogs || [],
        staging: [],
        vanTimes: vanTimes.data?.tomorrow || { BV: '07:30', DV: '08:00', SV: '08:30' }
      }
    },
    timestamp: new Date().toISOString()
  };
}

/**
 * Load board data from a specific tab
 * Column mapping: ID, Dog_Name, Photo, Walk, Stop_AM, VP_AM, VP_PM, Stop, Notes, Acuity_ID, Appointment_Type
 */
function loadBoardData(tabName) {
  const sheet = getOrCreateSheet(tabName);
  const data = sheet.getDataRange().getValues();
  
  if (data.length <= 1) {
    return { dogs: [] };
  }
  
  // ADDED: Build header-name → column-index map from row 0
  // This makes reading resilient to column order changes (e.g. n8n writing different field sets)
  const headers = data[0];
  const hdrMap = {};
  for (let c = 0; c < headers.length; c++) {
    const name = String(headers[c] || '').trim();
    if (name) hdrMap[name] = c;
  }
  
  // Helper: read cell by header name, with fallback to COLS index ONLY if no headers found
  // This prevents cross-contamination when columns are in unexpected order
  const hasHeaders = Object.keys(hdrMap).length > 0;
  function col(row, headerName, colsFallback) {
    if (hdrMap.hasOwnProperty(headerName)) return row[hdrMap[headerName]];
    // Only fall back to positional index if the sheet has NO recognisable headers
    if (!hasHeaders && typeof colsFallback === 'number' && colsFallback < row.length) return row[colsFallback];
    return undefined;
  }
  
  const dogs = [];
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const id = col(row, 'ID', COLS.ID);
    const dogName = col(row, 'Dog_Name', COLS.DOG_NAME);
    if (!id && !dogName) continue; // Skip empty rows
    
    const photoVal = col(row, 'Photo', COLS.PHOTO);
    
    dogs.push({
      id: id || generateId(),
      name: dogName || '',
      photo: photoVal === true || photoVal === 'TRUE' || photoVal === 'true',
      walk: col(row, 'Walk', COLS.WALK) || '',
      stopAM: col(row, 'Stop_AM', COLS.STOP_AM) || '',
      vpAM: col(row, 'VP_AM', COLS.VP_AM) || '',
      vpPM: col(row, 'VP_PM', COLS.VP_PM) || '',
      stop: col(row, 'Stop', COLS.STOP) || '',
      notes: col(row, 'Notes', COLS.NOTES) || '',
      acuityId: col(row, 'Acuity_ID', COLS.ACUITY_ID) || '',
      serviceType: col(row, 'Appointment_Type', COLS.APPOINTMENT_TYPE) || '',
      crate: col(row, 'Crate', COLS.CRATE) || '',
      // Grooming Dogs fields
      pickup: col(row, 'Pickup', COLS.PICKUP) || '',
      dropoff: col(row, 'Dropoff', COLS.DROPOFF) || '',
      vanType: col(row, 'Van_Type', COLS.VAN_TYPE) || '',
      // Boarding fields — reads by header name so column position doesn't matter
      checkIn: formatDateValue_(col(row, 'Check_In', COLS.CHECK_IN)),
      checkOut: formatDateValue_(col(row, 'Check_Out', COLS.CHECK_OUT)),
      crateSize: col(row, 'Crate_Size', COLS.CRATE_SIZE) || '',
      behaviour: col(row, 'Behaviour', COLS.BEHAVIOUR) || '',
      // Grooming-dog marker (boolean). Same TRUE/'true' coercion as photo.
      isGrooming: (function (v) { return v === true || v === 'TRUE' || v === 'true'; })(col(row, 'Is_Grooming', COLS.IS_GROOMING))
    });
  }
  
  return { dogs: dogs };
}

// =====================
// ROUTE-OWNED COLUMN GUARD (server-side, authoritative) — added 2026-06-08
// =====================
// These columns are also written DIRECTLY on the sheet by the n8n route push
// (updateVanRoute). The website's full-board save (saveBoardData via the 'save' /
// 'saveToday' / 'saveTomorrow' actions) must NOT overwrite them with a stale blank,
// or a route that was just sent gets wiped (dual-writer race — PM van codes / stop
// numbers vanish). On those website save paths we read the sheet's CURRENT values
// first and keep them for any dog whose incoming (page) value is blank. Non-blank
// page values (staff manually assigning a van) still win. This is the authoritative
// twin of the front-end mergeRouteOwnedFromRemote guard, so it protects EVERY
// client — including a browser tab still running old code — and, under the shared
// script lock, closes the read/write race vs updateVanRoute. NOT applied to
// transferTomorrowToToday (intentional clean overwrite) or the Acuity import (which
// writes the sheet directly via n8n Google Sheets nodes).
var ROUTE_OWNED_KEYS = ['vpAM', 'vpPM', 'stopAM', 'stop', 'isGrooming'];

/**
 * Read the current route-owned columns of a board tab, keyed by dog ID (by header
 * name, positional fallback). Used by the route-owned column guard.
 */
function readRouteOwnedById_(sheet) {
  var map = {};
  var values = sheet.getDataRange().getValues();
  if (values.length <= 1) return map;
  var headers = values[0], hdr = {};
  for (var c = 0; c < headers.length; c++) { var h = String(headers[c] || '').trim(); if (h) hdr[h] = c; }
  var idCol = hdr.hasOwnProperty('ID') ? hdr['ID'] : COLS.ID;
  var cols = {
    vpAM: hdr.hasOwnProperty('VP_AM') ? hdr['VP_AM'] : COLS.VP_AM,
    vpPM: hdr.hasOwnProperty('VP_PM') ? hdr['VP_PM'] : COLS.VP_PM,
    stopAM: hdr.hasOwnProperty('Stop_AM') ? hdr['Stop_AM'] : COLS.STOP_AM,
    stop: hdr.hasOwnProperty('Stop') ? hdr['Stop'] : COLS.STOP,
    isGrooming: hdr.hasOwnProperty('Is_Grooming') ? hdr['Is_Grooming'] : COLS.IS_GROOMING
  };
  for (var r = 1; r < values.length; r++) {
    var id = String(values[r][idCol] == null ? '' : values[r][idCol]).trim();
    if (!id) continue;
    map[id] = {
      vpAM: values[r][cols.vpAM], vpPM: values[r][cols.vpPM],
      stopAM: values[r][cols.stopAM], stop: values[r][cols.stop],
      isGrooming: values[r][cols.isGrooming]
    };
  }
  return map;
}

/**
 * Mutate `dogs` in place: for each dog (matched by ID), keep the sheet's current
 * route-owned value wherever the incoming page value is blank. Non-blank page
 * values win. isGrooming is only ever set TRUE (never cleared) by this merge.
 */
function mergeRouteOwnedIntoDogs_(sheet, dogs) {
  if (!dogs || !dogs.length) return;
  var existing = readRouteOwnedById_(sheet);
  for (var i = 0; i < dogs.length; i++) {
    var d = dogs[i];
    if (!d || !d.id) continue;
    var ex = existing[String(d.id).trim()];
    if (!ex) continue;
    for (var k = 0; k < ROUTE_OWNED_KEYS.length; k++) {
      var f = ROUTE_OWNED_KEYS[k];
      var lv = d[f];
      var blank = (lv === '' || lv === undefined || lv === null || lv === false);
      if (!blank) continue;
      var rv = ex[f];
      if (f === 'isGrooming') {
        if (rv === true || rv === 'TRUE' || rv === 'true') d[f] = true;
      } else if (!(rv === '' || rv === undefined || rv === null)) {
        d[f] = rv;
      }
    }
  }
}

/**
 * Save board data to a specific tab
 * Column order: ID, Dog_Name, Photo, Walk, Stop_AM, VP_AM, VP_PM, Stop, Notes, Acuity_ID, Appointment_Type
 * opts.preserveRouteColumns (website save paths only) keeps route-owned columns
 * the page doesn't have locally — see ROUTE-OWNED COLUMN GUARD above.
 */
function saveBoardData(tabName, dogs, opts) {
  opts = opts || {};
  const sheet = getOrCreateSheet(tabName);

  // EMPTY-SAVE WIPE GUARD (server-side, authoritative) — added 2026-06-10.
  // A website full-board save arriving with NO dogs for a tab that currently has
  // rows is almost always a broken client (page saved before its initial load
  // finished, a stale-cached page running old code, or stale in-memory state),
  // not a real "clear the board" instruction — this is what silently wiped the
  // Today tab. Refuse the destructive replace unless the client explicitly sends
  // allowEmpty (the updated front-end only does so after the user confirms).
  // Deliberate clears are unaffected: transferTomorrowToToday and clearBoard /
  // 'clearTomorrow' never set blockEmptyOverwrite, and the n8n imports write the
  // sheet directly with their own no-dogs guards.
  if (opts.blockEmptyOverwrite && (!dogs || dogs.length === 0)) {
    var existingRows = sheet.getLastRow() - 1;
    if (existingRows > 0) {
      try {
        getOrCreateSheet(TABS.IMPORT_LOG).appendRow([
          new Date().toISOString(), 'Save Guard', 0, 'Blocked',
          tabName + ': empty save refused — sheet has ' + existingRows + ' row(s)'
        ]);
      } catch (e) {}
      return {
        success: false, blocked: true, count: existingRows,
        error: 'Empty save blocked: ' + tabName + ' still has ' + existingRows
          + ' row(s) on the sheet. Send allowEmpty:true to clear it deliberately.'
      };
    }
  }

  // ROUTE-OWNED COLUMN GUARD: keep sheet van/stop values where the page's are blank,
  // under a best-effort script lock that serialises this read+write vs updateVanRoute.
  var _routeLock = null;
  if (opts.preserveRouteColumns) {
    try { _routeLock = LockService.getScriptLock(); _routeLock.waitLock(10000); }
    catch (e) {
      _routeLock = null;
      // Lock busy (updateVanRoute likely mid-write). We still merge best-effort —
      // the merge re-reads the sheet, so an ALREADY-committed route push is still
      // preserved — but this is the one narrow window where a push committing
      // between our read and write could be clobbered, so LOG it (don't fail the
      // save: the front-end posts no-cors and would show a false "Saved").
      try { getOrCreateSheet(TABS.IMPORT_LOG).appendRow([new Date().toISOString(), 'Route Guard', 0, 'Lock busy', tabName + ': save proceeded without the route-guard lock']); } catch (e2) {}
    }
    try { mergeRouteOwnedIntoDogs_(sheet, dogs); } catch (mErr) {
      try { getOrCreateSheet(TABS.IMPORT_LOG).appendRow([new Date().toISOString(), 'Route Merge', 0, 'Error', String((mErr && mErr.message) || mErr)]); } catch (e2) {}
    }
  }
  
  // Clear existing data (keep headers)
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.deleteRows(2, lastRow - 1);
  }
  
  // ADDED: Always ensure row 1 has correct BOARD_HEADERS (resilience against column misalignment)
  sheet.getRange(1, 1, 1, BOARD_HEADERS.length).setValues([BOARD_HEADERS]);
  
  // Write new data
  if (dogs && dogs.length > 0) {
    const rows = dogs.map(dog => [
      dog.id || generateId(),
      dog.name || '',
      dog.photo || false,
      dog.walk || '',
      dog.stopAM || '',
      dog.vpAM || '',
      dog.vpPM || '',
      dog.stop || '',
      dog.notes || '',
      dog.acuityId || '',
      dog.serviceType || '',
      dog.crate || '',
      // Grooming Dogs fields
      dog.pickup || '',
      dog.dropoff || '',
      dog.vanType || '',
      // Boarding School fields
      dog.checkIn || '',
      dog.checkOut || '',
      dog.crateSize || '',
      // Behaviour marker (1-5)
      dog.behaviour || '',
      // Grooming-dog marker — round-trips so the website save doesn't blank
      // the column that updateVanRoute writes.
      dog.isGrooming ? true : false
    ]);
    
    sheet.getRange(2, 1, rows.length, BOARD_HEADERS.length).setValues(rows);
  }

  // Release the route-owned-column guard lock (if held). On a thrown error above,
  // Apps Script auto-releases the script lock when the execution ends.
  if (_routeLock) _routeLock.releaseLock();

  return { success: true, count: dogs ? dogs.length : 0 };
}

/**
 * Save all data
 */
function saveAllData(data) {
  const results = {};
  
  if (data.today && data.today.dogs) {
    results.today = saveBoardData(TABS.TODAY, data.today.dogs, { preserveRouteColumns: true, blockEmptyOverwrite: !data.today.allowEmpty });
  }

  if (data.tomorrow && data.tomorrow.dogs) {
    results.tomorrow = saveBoardData(TABS.TOMORROW, data.tomorrow.dogs, { preserveRouteColumns: true, blockEmptyOverwrite: !data.tomorrow.allowEmpty });
  }
  
  // Handle vanTimes - can be at root level or nested in today/tomorrow
  if (data.vanTimes) {
    results.vanTimes = saveVanTimes(data.vanTimes);
  } else if (data.today?.vanTimes || data.tomorrow?.vanTimes) {
    results.vanTimes = saveVanTimes({
      today: data.today?.vanTimes || { BV: '07:30', DV: '08:00', SV: '08:30' },
      tomorrow: data.tomorrow?.vanTimes || { BV: '07:30', DV: '08:00', SV: '08:30' }
    });
  }
  
  return { success: true, results: results };
}

/**
 * Load van times from Settings tab
 */
function loadVanTimes() {
  const sheet = getOrCreateSheet(TABS.SETTINGS);
  const data = sheet.getDataRange().getValues();
  
  const vanTimes = {
    today: { BV: '07:30', DV: '08:00', SV: '08:30' },
    tomorrow: { BV: '07:30', DV: '08:00', SV: '08:30' }
  };
  
  // Parse settings rows (Setting | Value format)
  for (let i = 1; i < data.length; i++) {
    const setting = String(data[i][0] || '').trim();
    // ADDED: Handle Date objects (Google Sheets stores times as Date with base 1899-12-30)
    let value = '';
    const rawVal = data[i][1];
    if (rawVal instanceof Date) {
      const h = ('0' + rawVal.getHours()).slice(-2);
      const m = ('0' + rawVal.getMinutes()).slice(-2);
      value = h + ':' + m;
    } else {
      value = String(rawVal || '').trim();
    }
    
    if (setting === 'BV_Time_Today') vanTimes.today.BV = value || '07:30';
    if (setting === 'DV_Time_Today') vanTimes.today.DV = value || '08:00';
    if (setting === 'SV_Time_Today') vanTimes.today.SV = value || '08:30';
    if (setting === 'BV_Time_Tomorrow') vanTimes.tomorrow.BV = value || '07:30';
    if (setting === 'DV_Time_Tomorrow') vanTimes.tomorrow.DV = value || '08:00';
    if (setting === 'SV_Time_Tomorrow') vanTimes.tomorrow.SV = value || '08:30';
  }
  
  return { success: true, data: vanTimes };
}

/**
 * Save van times to Settings tab
 */
function saveVanTimes(vanTimes) {
  const sheet = getOrCreateSheet(TABS.SETTINGS);
  const data = sheet.getDataRange().getValues();
  
  // Find and update van time settings
  const updates = {
    'BV_Time_Today': vanTimes.today?.BV || '07:30',
    'DV_Time_Today': vanTimes.today?.DV || '08:00',
    'SV_Time_Today': vanTimes.today?.SV || '08:30',
    'BV_Time_Tomorrow': vanTimes.tomorrow?.BV || '07:30',
    'DV_Time_Tomorrow': vanTimes.tomorrow?.DV || '08:00',
    'SV_Time_Tomorrow': vanTimes.tomorrow?.SV || '08:30'
  };
  
  for (let i = 1; i < data.length; i++) {
    const setting = String(data[i][0] || '').trim();
    if (updates.hasOwnProperty(setting)) {
      sheet.getRange(i + 1, 2).setValue(updates[setting]);
    }
  }
  
  return { success: true };
}

/**
 * Transfer Tomorrow to Today
 * UPDATED: Preserves VP_AM and VP_PM values
 * UPDATED: Preserves Check_In for continuing boarding stays (matched by dog name)
 *          Check_Out is updated daily from Boarding Planner data
 */
function transferTomorrowToToday() {
  // Load tomorrow's data
  const tomorrowData = loadBoardData(TABS.TOMORROW);
  const vanTimes = loadVanTimes();
  
  if (!tomorrowData.dogs || tomorrowData.dogs.length === 0) {
    return { success: false, error: 'No dogs in Tomorrow board to transfer' };
  }
  
  // ADDED: Load existing Today data to preserve Check_In for continuing boarding stays
  // This ensures the check-in date stays fixed from the first day a dog boards,
  // even if the Boarding Planner API was unavailable during a later import.
  const existingTodayData = loadBoardData(TABS.TODAY);
  const existingTodayMap = {};
  if (existingTodayData.dogs && existingTodayData.dogs.length > 0) {
    existingTodayData.dogs.forEach(dog => {
      const key = (dog.name || '').trim().toLowerCase();
      if (key) {
        existingTodayMap[key] = dog;
      }
    });
  }
  
  // ADDED: Load the per-dog van roster once so we can upgrade any leftover 'V'
  // placeholder to the dog's real van size (BV/SV/DV) as we transfer. This makes
  // the Today tab correct even if the n8n Tomorrow-side resolve never ran/failed.
  const vanRoster = loadVanRoster_();
  const vanRosterKeys = Object.keys(vanRoster);
  const vanUnresolved = [];

  // Transfer all data, only reset photo (fresh day) and adjust walk status
  // Notes, vpAM, vpPM, stopAM, stop are all preserved via spread
  const todayDogs = tomorrowData.dogs.map(dog => {
    const mapped = {
      ...dog,
      photo: false,  // Reset photo for new day
      walk: dog.walk === 'transferred' ? 'booked' : dog.walk
    };

    // ADDED: Resolve the 'V' van placeholder -> BV/SV/DV from the roster.
    // Only touches fields that are exactly 'V'; P / XV / already-set codes are
    // left untouched. Dogs that can't be matched (blank roster van type or a
    // name mismatch) keep 'V' and are reported back to the dispatcher.
    if (mapped.vpAM === 'V' || mapped.vpPM === 'V') {
      const resolvedVan = resolveVanFromRoster_(mapped.name, vanRoster, vanRosterKeys);
      if (resolvedVan) {
        if (mapped.vpAM === 'V') mapped.vpAM = resolvedVan;
        if (mapped.vpPM === 'V') mapped.vpPM = resolvedVan;
      } else {
        vanUnresolved.push(mapped.name);
      }
    }

    // ADDED: For boarding dogs, preserve Check_In from existing Today data
    // Check_Out updates daily (reflects latest Boarding Planner data)
    const serviceType = (dog.serviceType || '').toLowerCase();
    if (serviceType.includes('boarding')) {
      const key = (dog.name || '').trim().toLowerCase();
      const existing = existingTodayMap[key];
      
      if (existing && existing.checkIn) {
        // Boarding dog already in Today with a Check_In — preserve it
        mapped.checkIn = existing.checkIn;
        
        // Check_Out: use Tomorrow's value (updated daily from Boarding Planner)
        // Falls back to existing if Tomorrow has no value
        if (!mapped.checkOut && existing.checkOut) {
          mapped.checkOut = existing.checkOut;
        }
      }
      // If no existing Check_In, keep Tomorrow's value (set by n8n import)
    }
    
    return mapped;
  });
  
  // Save to Today
  saveBoardData(TABS.TODAY, todayDogs);
  
  // Transfer van times
  if (vanTimes.data) {
    vanTimes.data.today = { ...vanTimes.data.tomorrow };
    vanTimes.data.tomorrow = { BV: '07:30', DV: '08:00', SV: '08:30' };
    saveVanTimes(vanTimes.data);
  }
  
  // Clear Tomorrow
  clearBoard(TABS.TOMORROW);
  
  // Update Last_Transfer setting
  updateSetting('Last_Transfer', new Date().toISOString());
  
  // Log the transfer (note any dogs whose van type couldn't be resolved)
  const vanNote = vanUnresolved.length
    ? (' · ' + vanUnresolved.length + ' still need a van type: ' + vanUnresolved.join(', '))
    : '';
  const logSheet = getOrCreateSheet(TABS.IMPORT_LOG);
  logSheet.appendRow([
    new Date().toISOString(),
    'Transfer',
    todayDogs.length,
    'Success',
    'Transferred Tomorrow → Today' + vanNote
  ]);

  return {
    success: true,
    transferred: todayDogs.length,
    vanUnresolved: vanUnresolved,
    message: 'Transferred ' + todayDogs.length + ' dogs to Today'
      + (vanUnresolved.length
          ? (' — ⚠️ ' + vanUnresolved.length + ' still need a van type set in the Van Assignment roster: ' + vanUnresolved.join(', '))
          : '')
  };
}

/**
 * Update a setting value
 */
function updateSetting(settingName, value) {
  const sheet = getOrCreateSheet(TABS.SETTINGS);
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === settingName) {
      sheet.getRange(i + 1, 2).setValue(value);
      return true;
    }
  }
  
  // Setting not found, append it
  sheet.appendRow([settingName, value]);
  return true;
}

/**
 * Clear a board
 */
function clearBoard(tabName) {
  const sheet = getOrCreateSheet(tabName);
  const lastRow = sheet.getLastRow();
  
  if (lastRow > 1) {
    sheet.deleteRows(2, lastRow - 1);
  }
  
  return { success: true };
}

// =====================
// VAN ROUTE PUSH (from Load Planner / RouteXL)  — ADDED 2026-05-27
// =====================

/**
 * Apply an optimised van route from the Load Planner to the board.
 *
 * Called via doPost action 'updateRoute'. The Load Planner's n8n
 * "Whiteboard — Update" node POSTs:
 *   { action:'updateRoute', van:'BV'|'SV'|'DV', period:'PM'|'NEXT_AM'|'AM',
 *     stops:[ { name:'<dog>', stop:1 }, ... ] }
 *
 * Period → tab/field mapping (locked with Kam 2026-05-27):
 *   - PM / evening route (planned same day)   → Today tab,    VP_PM + Stop
 *   - NEXT_AM / AM route  (planned a day ahead) → Tomorrow tab, VP_AM + Stop_AM
 *
 * Behaviour:
 *   - CLEAR-FIRST: any dog currently marked as this van in this period has
 *     its van code + stop number blanked, so a dog removed from a re-sent
 *     route doesn't keep a stale number.
 *   - Each routed dog is fuzzy-matched (Levenshtein similarity ≥ 0.70, the
 *     same threshold as the Load Planner's Stage 2) to a board row, because
 *     names differ between the master "Jot form" sheet and Acuity+surname.
 *     The matched row gets vpField = van and stopField = the stop number.
 *   - Unmatched routed dogs are reported back (never silently dropped) and
 *     no new rows are created.
 *   - TARGETED WRITE: only the two affected columns (the period's VP + Stop)
 *     are read and written back — NOT the whole board. This (a) preserves
 *     every other column instead of round-tripping it through loadBoardData/
 *     saveBoardData (which would silently drop any column not in
 *     BOARD_HEADERS), and (b) keeps the locked window short. Note the lock
 *     only serialises updateVanRoute against itself — the website's save path
 *     does not take this lock — so the narrow two-column write also limits
 *     what a concurrent website save could clobber to just those cells.
 */
function updateVanRoute(data) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    return { success: false, error: 'Could not obtain script lock — board busy, try again.' };
  }

  try {
    var van = String(data.van || '').trim().toUpperCase();
    var period = String(data.period || '').trim().toUpperCase();
    var stops = Array.isArray(data.stops) ? data.stops : [];
    // Run type (FD/HD) from the route payload. For a PM write it scopes which
    // board SECTION this route owns (see the rows loop below); '' / non-HD = the
    // full-day section. Added 2026-06-09 for the Half Day afternoon-run split.
    var runType = String(data.run_type || '').trim().toUpperCase();

    if (!van) return { success: false, error: 'Missing van.' };

    // Period → tab + the two affected column HEADERS.
    var tabName, vpHeader, stopHeader, vpFallback, stopFallback;
    if (period === 'PM') {
      tabName = TABS.TODAY;    vpHeader = 'VP_PM'; stopHeader = 'Stop';
      vpFallback = COLS.VP_PM; stopFallback = COLS.STOP;
    } else if (period === 'NEXT_AM' || period === 'AM') {
      tabName = TABS.TOMORROW; vpHeader = 'VP_AM'; stopHeader = 'Stop_AM';
      vpFallback = COLS.VP_AM; stopFallback = COLS.STOP_AM;
    } else {
      return { success: false, error: 'Unknown period: ' + period };
    }

    var sheet = getOrCreateSheet(tabName);
    var values = sheet.getDataRange().getValues();
    if (values.length <= 1) {
      // Empty board — nothing to match against.
      return {
        success: true, van: van, period: period, tab: tabName,
        updated: [],
        unmatched: stops.map(function (s) {
          return { route_name: String(s.name || '').trim(), stop: s.stop, best_score: 0 };
        })
      };
    }

    // Resolve the column indices from the header row (fall back to the
    // canonical COLS index only if the header isn't present).
    var headers = values[0];
    var hdr = {};
    for (var c = 0; c < headers.length; c++) {
      var hName = String(headers[c] || '').trim();
      if (hName) hdr[hName] = c;
    }
    var nameCol = hdr.hasOwnProperty('Dog_Name') ? hdr['Dog_Name'] : COLS.DOG_NAME;
    var vpCol   = hdr.hasOwnProperty(vpHeader) ? hdr[vpHeader] : vpFallback;
    var stopCol = hdr.hasOwnProperty(stopHeader) ? hdr[stopHeader] : stopFallback;

    // Grooming marker column — period-independent (same Is_Grooming column for
    // AM and PM). Resolve once, and make sure the header exists so loadBoardData
    // reads the marker BY NAME (it only falls back to a positional column when
    // the sheet has NO headers at all). Additive — never touches other columns.
    var gdHeader = 'Is_Grooming';
    var gdCol = hdr.hasOwnProperty(gdHeader) ? hdr[gdHeader] : COLS.IS_GROOMING;
    if (!hdr.hasOwnProperty(gdHeader)) {
      sheet.getRange(1, gdCol + 1).setValue(gdHeader);
    }

    // Appointment_Type column — read ONLY (never written). Used solely to classify
    // a row as Half Day vs full-day for the PM section scoping below.
    var apptHeader = 'Appointment_Type';
    var apptCol = hdr.hasOwnProperty(apptHeader) ? hdr[apptHeader] : COLS.APPOINTMENT_TYPE;

    // Snapshot ONLY the affected columns (one column each), preserving every
    // preserving every data row's current value. dataRows = values minus the
    // header. vpVals[r] / stopVals[r] correspond to values[r + 1].
    var dataRows = values.length - 1;
    var vpRange = sheet.getRange(2, vpCol + 1, dataRows, 1);
    var stopRange = sheet.getRange(2, stopCol + 1, dataRows, 1);
    var vpVals = vpRange.getValues();     // [[v], [v], ...]
    var stopVals = stopRange.getValues();
    // Third targeted column — the grooming marker (see above). Same shape.
    var gdRange = sheet.getRange(2, gdCol + 1, dataRows, 1);
    var gdVals = gdRange.getValues();

    // For a PM write, scope the candidate rows to ONE section so a Half Day (HD)
    // send and a Full Day (FD) send never touch each other's Stop numbers — both
    // share the VP_PM/Stop columns on the Today tab. HD → only Half Day rows;
    // FD / '' → only non-Half-Day rows. NEXT_AM/AM is unscoped (no Half Day split
    // on the Tomorrow tab). Added 2026-06-09 for the Half Day afternoon run.
    var scopePM = (period === 'PM');
    var wantHalfDay = (runType === 'HD');

    // Build a lightweight model of the named rows (skip blank + out-of-section rows).
    var rows = [];
    for (var r = 0; r < dataRows; r++) {
      var nm = String(values[r + 1][nameCol] || '');
      if (!nm) continue;
      if (scopePM) {
        var rowHalfDay = /half\s*day/i.test(String(values[r + 1][apptCol] || ''));
        if (rowHalfDay !== wantHalfDay) continue;       // belongs to the other run
      }
      rows.push({
        vi: r,                                            // index into vpVals/stopVals
        name: nm,
        currentVp: String(vpVals[r][0] || '').trim().toUpperCase()
      });
    }

    // 1) CLEAR-FIRST — wipe this van's marks in this period so a dog
    //    dropped from a re-sent route doesn't keep a stale number.
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].currentVp === van) {
        vpVals[rows[i].vi][0] = '';
        stopVals[rows[i].vi][0] = '';
        gdVals[rows[i].vi][0] = false;   // drop stale grooming marker for this van
      }
    }

    // 2) Fuzzy-match each routed dog to a board row and stamp van + stop.
    var used = {};            // row-model index already claimed by this route
    var updated = [];
    var unmatched = [];

    for (var s = 0; s < stops.length; s++) {
      var routeName = String(stops[s].name || '').trim();
      var stopNo = stops[s].stop;
      if (!routeName) continue;

      var bestIdx = -1;
      var bestScore = 0;
      for (var d = 0; d < rows.length; d++) {
        if (used[d]) continue;
        var score = routeSimilarity_(routeName, rows[d].name);
        if (score > bestScore) { bestScore = score; bestIdx = d; }
      }

      if (bestIdx >= 0 && bestScore >= ROUTE_MATCH_THRESHOLD) {
        used[bestIdx] = true;
        // Guard the stop value: only write a real (finite) stop number,
        // otherwise blank — never the literal string "undefined".
        var stopText = (typeof stopNo === 'number' && isFinite(stopNo))
          ? String(stopNo)
          : (stopNo != null && String(stopNo).trim() !== '' && isFinite(Number(stopNo))
              ? String(Number(stopNo)) : '');
        vpVals[rows[bestIdx].vi][0] = van;
        stopVals[rows[bestIdx].vi][0] = stopText;
        // Grooming marker from the per-dog flag n8n now sends (false otherwise,
        // so a matched non-grooming dog never inherits a stale TRUE).
        gdVals[rows[bestIdx].vi][0] = (stops[s].is_grooming === true);
        updated.push({ route_name: routeName, board_name: rows[bestIdx].name, stop: stopNo, score: Math.round(bestScore * 100) / 100 });
      } else {
        unmatched.push({ route_name: routeName, stop: stopNo, best_score: Math.round(bestScore * 100) / 100 });
      }
    }

    // 3) Persist — write back ONLY the affected columns (VP + Stop + grooming).
    vpRange.setValues(vpVals);
    stopRange.setValues(stopVals);
    gdRange.setValues(gdVals);

    // 4) Audit log.
    var logSheet = getOrCreateSheet(TABS.IMPORT_LOG);
    logSheet.appendRow([
      new Date().toISOString(),
      'Route Update',
      updated.length,
      unmatched.length ? 'Partial' : 'Success',
      van + ' ' + period + ' → ' + tabName + ': ' + updated.length + ' placed' +
        (unmatched.length ? (', ' + unmatched.length + ' unmatched (' +
          unmatched.map(function (u) { return u.route_name; }).join('; ') + ')') : '')
    ]);

    return {
      success: true,
      van: van,
      period: period,
      tab: tabName,
      updated: updated,
      unmatched: unmatched
    };
  } finally {
    lock.releaseLock();
  }
}

// ---- Fuzzy name matching (ported from stage2_fuzzy_match.js) ----
// Same algorithm + threshold the Load Planner uses, so a name that routes
// there matches here too.
var ROUTE_MATCH_THRESHOLD = 0.70;

function normaliseName_(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}\s'-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function routeLevenshtein_(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  var prev = new Array(b.length + 1);
  var curr = new Array(b.length + 1);
  for (var j = 0; j <= b.length; j++) prev[j] = j;
  for (var i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (var k = 1; k <= b.length; k++) {
      var cost = a.charCodeAt(i - 1) === b.charCodeAt(k - 1) ? 0 : 1;
      curr[k] = Math.min(curr[k - 1] + 1, prev[k] + 1, prev[k - 1] + cost);
    }
    var tmp = prev; prev = curr; curr = tmp;
  }
  return prev[b.length];
}

function routeSimilarity_(a, b) {
  a = normaliseName_(a);
  b = normaliseName_(b);
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  var maxLen = Math.max(a.length, b.length);
  return 1 - (routeLevenshtein_(a, b) / maxLen);
}

// =====================
// VAN ROSTER (transfer-time "V" -> BV/SV/DV resolution)
// =====================
// The per-dog van roster lives on a DIFFERENT spreadsheet (the master
// "Jot form Dog Details" sheet), Master tab gid 0, cols A = Dog Name,
// J = "Van Typs" (moved here 2026-06-09 from the old standalone tab gid 727258177 col B).
// Reading it requires the cross-spreadsheet Spreadsheet scope, so the FIRST run after deploy
// prompts for re-authorisation. Mirrors getVanSheet_() in van_assignment_api.gs.
// This is the same source n8n now reads to resolve "V" on the Tomorrow tab;
// resolving again here makes the Today tab correct even if the n8n resolve
// never ran or failed.
var VAN_ROSTER_SHEET_ID = '1OD8SQR2WxgO0nncXwBKYAkNv-qAhw018CXaH4kWgTDU';
var VAN_ROSTER_TAB_GID = 0;
var VAN_VALID_CODES = ['BV', 'SV', 'DV'];

/**
 * Load the per-dog van roster as { normalisedName -> 'BV'|'SV'|'DV' }.
 * Only rows carrying a real BV/SV/DV code are included (blank = unassigned).
 * Returns {} on any failure so a transfer never breaks if the roster is
 * unreachable / not yet authorised.
 */
function loadVanRoster_() {
  var map = {};
  try {
    var ss = SpreadsheetApp.openById(VAN_ROSTER_SHEET_ID);
    var sheets = ss.getSheets();
    var sheet = null;
    for (var i = 0; i < sheets.length; i++) {
      if (sheets[i].getSheetId() === VAN_ROSTER_TAB_GID) { sheet = sheets[i]; break; }
    }
    if (!sheet) return map;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return map;
    var values = sheet.getRange(2, 1, lastRow - 1, 10).getValues();  // A = name ... J = van type (col J)
    for (var r = 0; r < values.length; r++) {
      var name = String(values[r][0] == null ? '' : values[r][0]).trim();
      if (!name) continue;
      var van = String(values[r][9] == null ? '' : values[r][9]).trim().toUpperCase();
      if (VAN_VALID_CODES.indexOf(van) !== -1) map[normaliseName_(name)] = van;
    }
  } catch (e) {
    // openById not yet authorised, or sheet unreachable — leave map empty.
  }
  return map;
}

/**
 * Resolve a dog's van size from the roster. Exact normalised-name match first,
 * then a high-confidence fuzzy fallback (a single roster name scoring >= 0.85,
 * clearly ahead of the runner-up) to absorb spelling drift like
 * "Rolo Branswell" vs "Rollo Barnwell". Returns 'BV'/'SV'/'DV' or '' if not
 * confidently matched.
 */
function resolveVanFromRoster_(dogName, roster, rosterKeys) {
  var key = normaliseName_(dogName);
  if (!key) return '';
  if (roster[key]) return roster[key];
  var best = '', bestScore = 0, secondScore = 0;
  for (var i = 0; i < rosterKeys.length; i++) {
    var score = routeSimilarity_(key, rosterKeys[i]);
    if (score > bestScore) { secondScore = bestScore; bestScore = score; best = rosterKeys[i]; }
    else if (score > secondScore) { secondScore = score; }
  }
  if (best && bestScore >= 0.85 && (bestScore - secondScore) >= 0.05) return roster[best];
  return '';
}

/**
 * One-click AUTHORISE + VERIFY for the van roster read.
 *
 * Run this once from the Apps Script editor after deploying: it will trigger the
 * Google consent screen for the new cross-spreadsheet Spreadsheet scope (needed
 * by loadVanRoster_), then log how many BV/SV/DV entries the roster holds. A
 * non-zero count confirms transfer-time V→BV/SV/DV resolution can work.
 * Read-only — touches no board data.
 */
function authoriseVanRoster() {
  var roster = loadVanRoster_();
  var count = Object.keys(roster).length;
  Logger.log('Van roster read OK: ' + count + ' dogs with a BV/SV/DV van type.');
  return count;
}

// =====================
// FAIL-SAFE — heal any leftover "V" on the TODAY tab (last resort)
// =====================
// ADDED 2026-06-03. Belt-and-braces net so a stray "V" can never sit on the
// Today board regardless of which upstream step failed (n8n import error, a
// pre-fix or no-op Transfer, or an unauthorised roster read at transfer time):
// whenever the board is loaded, any Today VP_AM / VP_PM that is exactly "V" is
// upgraded to the dog's real BV / SV / DV from the van roster. Only fields equal
// to "V" are touched — P / XV / existing codes are never changed; a dog with no
// roster code keeps "V" (and is named in the audit row).
//
// Designed to be safe on the hot load path:
//   • THROTTLED via the script cache (at most one roster read per
//     VAN_FAILSAFE_THROTTLE_SECONDS across ALL clients) so a permanently
//     unresolvable "V" can't make every poll re-read the roster.
//   • CHEAP PRE-SCAN: bails before the cross-spreadsheet roster read / lock when
//     there is no "V" to heal.
//   • TARGETED WRITE of just VP_AM / VP_PM under the SAME script lock as
//     updateVanRoute (preserves every other column, short lock window).
//   • NEVER THROWS to the caller — a board load is never blocked by the net.
// The audit row records the roster size too, which doubles as the tell-tale of
// an unauthorised openById scope on the live /exec (roster 0 codes while "V"s
// remain). Pass force=true (the ?action=resolveTodayVans endpoint) to bypass the
// throttle for an on-demand sweep.
var VAN_FAILSAFE_CACHE_KEY = 'vanFailsafeRan';
var VAN_FAILSAFE_THROTTLE_SECONDS = 90;

function resolveTodayVansFailsafe_(force) {
  try {
    var cache = CacheService.getScriptCache();
    if (!force && cache.get(VAN_FAILSAFE_CACHE_KEY)) return { skipped: 'throttled' };

    // Whitespace/case-tolerant "is this cell the bare placeholder V?" — also
    // catches 'V ' / 'v' that the strict === 'V' elsewhere would miss.
    var isV = function (v) {
      return String(v == null ? '' : v).trim().toUpperCase() === 'V';
    };

    var sheet = getOrCreateSheet(TABS.TODAY);
    var values = sheet.getDataRange().getValues();
    if (values.length <= 1) return { healed: 0, unresolved: 0 };

    // Resolve Dog_Name / VP_AM / VP_PM columns by header (positional fallback
    // only — same approach as updateVanRoute — so a reordered sheet still works).
    var headers = values[0];
    var hdr = {};
    for (var c = 0; c < headers.length; c++) {
      var hName = String(headers[c] || '').trim();
      if (hName) hdr[hName] = c;
    }
    var nameCol = hdr.hasOwnProperty('Dog_Name') ? hdr['Dog_Name'] : COLS.DOG_NAME;
    var amCol = hdr.hasOwnProperty('VP_AM') ? hdr['VP_AM'] : COLS.VP_AM;
    var pmCol = hdr.hasOwnProperty('VP_PM') ? hdr['VP_PM'] : COLS.VP_PM;

    // Cheap pre-scan: nothing exactly "V" => nothing to do (skip roster read+lock).
    var anyV = false;
    for (var r = 1; r < values.length; r++) {
      if (isV(values[r][amCol]) || isV(values[r][pmCol])) { anyV = true; break; }
    }
    if (!anyV) return { healed: 0, unresolved: 0 };

    // There IS a "V" — serialise the heal against updateVanRoute / itself.
    var lock = LockService.getScriptLock();
    try { lock.waitLock(5000); }
    catch (e) { return { skipped: 'locked' }; }   // no throttle set -> retry next load

    try {
      // Re-read inside the lock (the board may have changed while we waited).
      values = sheet.getDataRange().getValues();
      var dataRows = values.length - 1;
      if (dataRows < 1) return { healed: 0, unresolved: 0 };

      var roster = loadVanRoster_();
      var rosterKeys = Object.keys(roster);

      var amRange = sheet.getRange(2, amCol + 1, dataRows, 1);
      var pmRange = sheet.getRange(2, pmCol + 1, dataRows, 1);
      var amVals = amRange.getValues();
      var pmVals = pmRange.getValues();

      var healed = 0, unresolved = 0, changedAm = false, changedPm = false;
      var unresolvedNames = [];

      for (var i = 0; i < dataRows; i++) {
        var amIsV = isV(amVals[i][0]);
        var pmIsV = isV(pmVals[i][0]);
        if (!amIsV && !pmIsV) continue;

        var name = String(values[i + 1][nameCol] || '').trim();
        if (!name) continue;

        // One roster code per dog drives BOTH the AM and PM van (same physical
        // van); only the field(s) currently "V" are overwritten.
        var van = rosterKeys.length ? resolveVanFromRoster_(name, roster, rosterKeys) : '';
        if (van) {
          if (amIsV) { amVals[i][0] = van; changedAm = true; healed++; }
          if (pmIsV) { pmVals[i][0] = van; changedPm = true; healed++; }
        } else {
          unresolved++;
          unresolvedNames.push(name);
        }
      }

      // Persist ONLY the columns we actually changed.
      if (changedAm) amRange.setValues(amVals);
      if (changedPm) pmRange.setValues(pmVals);

      // Bound the heavy path: at most one roster read per throttle window
      // (set after a real run, whatever the outcome).
      cache.put(VAN_FAILSAFE_CACHE_KEY, '1', VAN_FAILSAFE_THROTTLE_SECONDS);

      // Audit only when we changed something OR the roster came back empty while
      // "V"s remain (the unauthorised-openById-scope tell) — avoids log spam for
      // by-design "no roster code yet" dogs.
      if (healed > 0 || rosterKeys.length === 0) {
        getOrCreateSheet(TABS.IMPORT_LOG).appendRow([
          new Date().toISOString(),
          'Van Failsafe',
          healed,
          rosterKeys.length === 0 ? 'Roster empty' : (unresolved ? 'Partial' : 'Success'),
          'Today V→van: ' + healed + ' healed, ' + unresolved + ' still "V"' +
            ' (roster ' + rosterKeys.length + ' codes)' +
            (unresolvedNames.length ? ': ' + unresolvedNames.join(', ') : '')
        ]);
      }

      return { healed: healed, unresolved: unresolved, rosterSize: rosterKeys.length };
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    // Never block a board load on the fail-safe — log and move on.
    try {
      getOrCreateSheet(TABS.IMPORT_LOG).appendRow([
        new Date().toISOString(), 'Van Failsafe', 0, 'Error', String((e && e.message) || e)
      ]);
    } catch (e2) {}
    return { healed: 0, unresolved: 0, error: String((e && e.message) || e) };
  }
}

// =====================
// FAIL-SAFE — heal any leftover "V" on the TOMORROW tab (AM ONLY)
// =====================
// ADDED 2026-06-04. Tomorrow-tab sibling of resolveTodayVansFailsafe_ for the AM
// van PRE-ASSIGNMENT that the n8n 14:05 pull performs (chain 9→12). Belt-and-braces
// net: whenever the Tomorrow tab is served, any VP_AM that is exactly "V" is
// upgraded to the dog's real BV/SV/DV from the van roster — so the morning route
// has a van even if the n8n resolve ever fails again (the OOM that prompted this).
// SCOPE DIFFERS from the Today net BY DESIGN (Kam, 2026-06-04): on the Tomorrow
// tab only VP_AM is healed — VP_PM is LEFT ALONE (PM is resolved later, at the
// Tomorrow→Today transfer + the Today net). Only a cell exactly "V" is touched;
// P / XV / existing codes are never changed; a dog with NO roster van type keeps
// "V" (and is named in the audit row). Same safety as the Today net: throttled via
// script cache (own key), cheap pre-scan, targeted write of just VP_AM under the
// script lock, never throws. Pass force=true (?action=resolveTomorrowVans) to
// bypass the throttle for an on-demand sweep.
var VAN_FAILSAFE_TOMORROW_CACHE_KEY = 'vanFailsafeTomorrowRan';

function resolveTomorrowVansFailsafe_(force) {
  try {
    var cache = CacheService.getScriptCache();
    if (!force && cache.get(VAN_FAILSAFE_TOMORROW_CACHE_KEY)) return { skipped: 'throttled' };

    // Whitespace/case-tolerant "is this cell the bare placeholder V?".
    var isV = function (v) {
      return String(v == null ? '' : v).trim().toUpperCase() === 'V';
    };

    var sheet = getOrCreateSheet(TABS.TOMORROW);
    var values = sheet.getDataRange().getValues();
    if (values.length <= 1) return { healed: 0, unresolved: 0 };

    // Resolve Dog_Name / VP_AM columns by header (positional fallback only).
    var headers = values[0];
    var hdr = {};
    for (var c = 0; c < headers.length; c++) {
      var hName = String(headers[c] || '').trim();
      if (hName) hdr[hName] = c;
    }
    var nameCol = hdr.hasOwnProperty('Dog_Name') ? hdr['Dog_Name'] : COLS.DOG_NAME;
    var amCol = hdr.hasOwnProperty('VP_AM') ? hdr['VP_AM'] : COLS.VP_AM;

    // Cheap pre-scan: nothing exactly "V" in the AM column => nothing to do.
    var anyV = false;
    for (var r = 1; r < values.length; r++) {
      if (isV(values[r][amCol])) { anyV = true; break; }
    }
    if (!anyV) return { healed: 0, unresolved: 0 };

    // There IS an AM "V" — serialise the heal against updateVanRoute / itself.
    var lock = LockService.getScriptLock();
    try { lock.waitLock(5000); }
    catch (e) { return { skipped: 'locked' }; }   // no throttle set -> retry next load

    try {
      // Re-read inside the lock (the board may have changed while we waited).
      values = sheet.getDataRange().getValues();
      var dataRows = values.length - 1;
      if (dataRows < 1) return { healed: 0, unresolved: 0 };

      var roster = loadVanRoster_();
      var rosterKeys = Object.keys(roster);

      var amRange = sheet.getRange(2, amCol + 1, dataRows, 1);
      var amVals = amRange.getValues();

      var healed = 0, unresolved = 0, changedAm = false;
      var unresolvedNames = [];

      for (var i = 0; i < dataRows; i++) {
        // AM ONLY — VP_PM on the Tomorrow tab is deliberately left untouched.
        if (!isV(amVals[i][0])) continue;

        var name = String(values[i + 1][nameCol] || '').trim();
        if (!name) continue;

        var van = rosterKeys.length ? resolveVanFromRoster_(name, roster, rosterKeys) : '';
        if (van) {
          amVals[i][0] = van; changedAm = true; healed++;
        } else {
          // Van type missing for this dog in the roster -> leave "V" (per Kam).
          unresolved++;
          unresolvedNames.push(name);
        }
      }

      // Persist ONLY the AM column.
      if (changedAm) amRange.setValues(amVals);

      // Bound the heavy path: at most one roster read per throttle window.
      cache.put(VAN_FAILSAFE_TOMORROW_CACHE_KEY, '1', VAN_FAILSAFE_THROTTLE_SECONDS);

      // Audit only when we changed something OR the roster came back empty while
      // an AM "V" remains (the unauthorised-openById-scope tell).
      if (healed > 0 || rosterKeys.length === 0) {
        getOrCreateSheet(TABS.IMPORT_LOG).appendRow([
          new Date().toISOString(),
          'Van Failsafe (Tomorrow AM)',
          healed,
          rosterKeys.length === 0 ? 'Roster empty' : (unresolved ? 'Partial' : 'Success'),
          'Tomorrow AM V→van: ' + healed + ' healed, ' + unresolved + ' still "V"' +
            ' (roster ' + rosterKeys.length + ' codes)' +
            (unresolvedNames.length ? ': ' + unresolvedNames.join(', ') : '')
        ]);
      }

      return { healed: healed, unresolved: unresolved, rosterSize: rosterKeys.length };
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    // Never block a board load on the fail-safe — log and move on.
    try {
      getOrCreateSheet(TABS.IMPORT_LOG).appendRow([
        new Date().toISOString(), 'Van Failsafe (Tomorrow AM)', 0, 'Error', String((e && e.message) || e)
      ]);
    } catch (e2) {}
    return { healed: 0, unresolved: 0, error: String((e && e.message) || e) };
  }
}

// =====================
// HELPER FUNCTIONS
// =====================

/**
 * Get or create a sheet with headers
 * UPDATED: Creates VP_AM and VP_PM columns
 */
function getOrCreateSheet(tabName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(tabName);
  
  if (!sheet) {
    sheet = ss.insertSheet(tabName);
    
    // Add headers based on tab type
    if (tabName === TABS.TODAY || tabName === TABS.TOMORROW) {
      sheet.getRange(1, 1, 1, BOARD_HEADERS.length).setValues([BOARD_HEADERS]);
    } else if (tabName === TABS.SETTINGS) {
      sheet.getRange(1, 1, 1, 2).setValues([['Setting', 'Value']]);
      sheet.getRange(2, 1, 8, 2).setValues([
        ['BV_Time_Today', '07:30'],
        ['DV_Time_Today', '08:00'],
        ['SV_Time_Today', '08:30'],
        ['BV_Time_Tomorrow', '07:30'],
        ['DV_Time_Tomorrow', '08:00'],
        ['SV_Time_Tomorrow', '08:30'],
        ['Last_Import', ''],
        ['Last_Transfer', '']
      ]);
    } else if (tabName === TABS.IMPORT_LOG) {
      sheet.getRange(1, 1, 1, 5).setValues([['Timestamp', 'Action', 'Dogs_Imported', 'Status', 'Details']]);
    }
  }
  
  return sheet;
}

/**
 * ADDED: Safely convert a date value from Google Sheets to 'YYYY-MM-DD' string.
 * Google Sheets may auto-format date strings as Date objects.
 * This ensures consistent string output for the frontend.
 */
function formatDateValue_(val) {
  if (!val) return '';
  if (val instanceof Date) {
    try {
      return Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    } catch (e) {
      // Fallback if Utilities not available in test context
      const y = val.getFullYear();
      const m = ('0' + (val.getMonth() + 1)).slice(-2);
      const d = ('0' + val.getDate()).slice(-2);
      return y + '-' + m + '-' + d;
    }
  }
  // ADDED: Strip ISO timestamp suffix (e.g. "2026-02-18T00:00:00.000Z" → "2026-02-18")
  const str = String(val).trim();
  if (str.includes('T')) {
    const dateOnly = str.split('T')[0];
    // Validate it looks like YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) {
      return dateOnly;
    }
  }
  return str;
}

/**
 * Generate unique ID
 */
function generateId() {
  return 'dog_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

/**
 * Create JSON response with CORS headers
 */
function createJsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// =====================
// MIGRATION HELPER
// =====================

/**
 * Run this ONCE to migrate existing sheet from VP to VP_AM/VP_PM
 * This will:
 * 1. Update headers
 * 2. Split existing VP data (V/V, V/P, P/V, P/P format) into two columns
 */
function migrateVPColumns() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  [TABS.TODAY, TABS.TOMORROW].forEach(tabName => {
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) return;
    
    const data = sheet.getDataRange().getValues();
    if (data.length === 0) return;
    
    // Check if already migrated (look for VP_AM header)
    const headers = data[0];
    if (headers.includes('VP_AM')) {
      Logger.log(tabName + ' already migrated');
      return;
    }
    
    // Find VP column index
    const vpIndex = headers.indexOf('VP');
    if (vpIndex === -1) {
      Logger.log(tabName + ' has no VP column');
      return;
    }
    
    // Insert new column for VP_PM after VP
    sheet.insertColumnAfter(vpIndex + 1);
    
    // Update headers
    sheet.getRange(1, vpIndex + 1).setValue('VP_AM');
    sheet.getRange(1, vpIndex + 2).setValue('VP_PM');
    
    // Migrate data rows
    for (let i = 1; i < data.length; i++) {
      const vpValue = String(data[i][vpIndex] || '');
      let vpAM = '';
      let vpPM = '';
      
      // Parse V/V, V/P, P/V, P/P format
      if (vpValue.includes('/')) {
        const parts = vpValue.split('/');
        vpAM = parts[0] || '';
        vpPM = parts[1] || '';
      } else if (vpValue === 'P') {
        vpAM = 'P';
        vpPM = 'P';
      } else if (vpValue === 'BV' || vpValue === 'DV' || vpValue === 'SV') {
        // Old format - assume van both ways
        vpAM = 'V';
        vpPM = 'V';
      }
      
      sheet.getRange(i + 1, vpIndex + 1).setValue(vpAM);
      sheet.getRange(i + 1, vpIndex + 2).setValue(vpPM);
    }
    
    Logger.log(tabName + ' migrated successfully');
  });
  
  Logger.log('Migration complete! Please verify your data and delete the old VP column manually if desired.');
}

// =====================
// INITIALIZATION
// =====================

/**
 * Run this once to set up all sheets with NEW column structure
 */
function initialSetup() {
  // Create all required sheets
  getOrCreateSheet(TABS.TODAY);
  getOrCreateSheet(TABS.TOMORROW);
  getOrCreateSheet(TABS.SETTINGS);
  getOrCreateSheet(TABS.IMPORT_LOG);
  
  Logger.log('Setup complete! All sheets created.');
  Logger.log('Tabs created: Today, Tomorrow, Settings, Import_Log');
  Logger.log('Column structure: ID, Dog_Name, Photo, Walk, VP_AM, VP_PM, Stop, Notes, Acuity_ID, Appointment_Type, Crate, Pickup, Dropoff, Van_Type, Check_In, Check_Out, Crate_Size');
  Logger.log('Next: Deploy as Web App (Execute as Me, Access Anyone)');
}

// =====================
// SCHEDULED FUNCTIONS
// =====================

/**
 * Daily cleanup at 6pm - Archive today's board
 * Set up a time-driven trigger for this
 */
function dailyBoardReset() {
  // Archive today's data (log the reset)
  const todayData = loadBoardData(TABS.TODAY);
  
  if (todayData.dogs && todayData.dogs.length > 0) {
    // Log the archive
    const logSheet = getOrCreateSheet(TABS.IMPORT_LOG);
    logSheet.appendRow([
      new Date().toISOString(),
      'Daily Reset',
      todayData.dogs.length,
      'Archived',
      'Daily 6pm board reset'
    ]);
  }
  
  // Clear today's board
  clearBoard(TABS.TODAY);
  
  Logger.log('Daily reset complete at 6pm');
}

// =====================
// CRATE COLUMN MIGRATION
// =====================

/**
 * Run this ONCE to add the Crate column (column L) to Today and Tomorrow sheets.
 * Safe to run multiple times — skips if column already exists.
 */
function addCrateColumn() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  [TABS.TODAY, TABS.TOMORROW].forEach(tabName => {
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      Logger.log(tabName + ' sheet not found — skipping');
      return;
    }
    
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    
    if (headers.includes('Crate')) {
      Logger.log(tabName + ' already has Crate column — skipping');
      return;
    }
    
    // Add Crate header in the next available column after Appointment_Type
    const nextCol = headers.length + 1;
    sheet.getRange(1, nextCol).setValue('Crate');
    
    Logger.log(tabName + ': Added Crate column at column ' + nextCol);
  });
  
  Logger.log('Crate column migration complete!');
  Logger.log('New column structure: ID | Dog_Name | Photo | Walk | Stop_AM | VP_AM | VP_PM | Stop | Notes | Acuity_ID | Appointment_Type | Crate');
}

// =====================
// GROOMING & BOARDING SCHOOL COLUMN MIGRATION
// =====================

/**
 * Run this ONCE to add the Grooming and Boarding School columns to Today and Tomorrow sheets.
 * Adds columns M-R: Pickup, Dropoff, Van_Type, Check_In, Check_Out, Crate_Size
 * Safe to run multiple times — skips columns that already exist.
 */
function addGroomingBoardingSchoolColumns() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const newColumns = ['Pickup', 'Dropoff', 'Van_Type', 'Check_In', 'Check_Out', 'Crate_Size'];
  
  [TABS.TODAY, TABS.TOMORROW].forEach(tabName => {
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      Logger.log(tabName + ' sheet not found — skipping');
      return;
    }
    
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    
    let addedCount = 0;
    newColumns.forEach(colName => {
      if (headers.includes(colName)) {
        Logger.log(tabName + ' already has ' + colName + ' column — skipping');
        return;
      }
      
      // Add header in the next available column
      const nextCol = headers.length + 1 + addedCount;
      sheet.getRange(1, nextCol).setValue(colName);
      addedCount++;
      Logger.log(tabName + ': Added ' + colName + ' column at column ' + nextCol);
    });
  });
  
  Logger.log('Grooming & Boarding School column migration complete!');
  Logger.log('New column structure: ID | Dog_Name | Photo | Walk | Stop_AM | VP_AM | VP_PM | Stop | Notes | Acuity_ID | Appointment_Type | Crate | Pickup | Dropoff | Van_Type | Check_In | Check_Out | Crate_Size');
}

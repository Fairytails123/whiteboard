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
// Sheet structure: ID | Dog_Name | Photo | Walk | Stop_AM | VP_AM | VP_PM | Stop | Notes | Acuity_ID | Appointment_Type | Crate | Pickup | Dropoff | Van_Type | Check_In | Check_Out | Crate_Size | Behaviour
const BOARD_HEADERS = ['ID', 'Dog_Name', 'Photo', 'Walk', 'Stop_AM', 'VP_AM', 'VP_PM', 'Stop', 'Notes', 'Acuity_ID', 'Appointment_Type', 'Crate', 'Pickup', 'Dropoff', 'Van_Type', 'Check_In', 'Check_Out', 'Crate_Size', 'Behaviour'];

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
  BEHAVIOUR: 18
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
        result = loadBoardData(TABS.TOMORROW);
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
        result = saveBoardData(TABS.TODAY, data.dogs);
        break;
      case 'saveTomorrow':
        result = saveBoardData(TABS.TOMORROW, data.dogs);
        break;
      case 'saveVanTimes':
        result = saveVanTimes(data.vanTimes);
        break;
      case 'transfer':
        result = transferTomorrowToToday();
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
      behaviour: col(row, 'Behaviour', COLS.BEHAVIOUR) || ''
    });
  }
  
  return { dogs: dogs };
}

/**
 * Save board data to a specific tab
 * Column order: ID, Dog_Name, Photo, Walk, Stop_AM, VP_AM, VP_PM, Stop, Notes, Acuity_ID, Appointment_Type
 */
function saveBoardData(tabName, dogs) {
  const sheet = getOrCreateSheet(tabName);
  
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
      dog.behaviour || ''
    ]);
    
    sheet.getRange(2, 1, rows.length, BOARD_HEADERS.length).setValues(rows);
  }
  
  return { success: true, count: dogs ? dogs.length : 0 };
}

/**
 * Save all data
 */
function saveAllData(data) {
  const results = {};
  
  if (data.today && data.today.dogs) {
    results.today = saveBoardData(TABS.TODAY, data.today.dogs);
  }
  
  if (data.tomorrow && data.tomorrow.dogs) {
    results.tomorrow = saveBoardData(TABS.TOMORROW, data.tomorrow.dogs);
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
  
  // Transfer all data, only reset photo (fresh day) and adjust walk status
  // Notes, vpAM, vpPM, stopAM, stop are all preserved via spread
  const todayDogs = tomorrowData.dogs.map(dog => {
    const mapped = {
      ...dog,
      photo: false,  // Reset photo for new day
      walk: dog.walk === 'transferred' ? 'booked' : dog.walk
    };
    
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
  
  // Log the transfer
  const logSheet = getOrCreateSheet(TABS.IMPORT_LOG);
  logSheet.appendRow([
    new Date().toISOString(),
    'Transfer',
    todayDogs.length,
    'Success',
    'Transferred Tomorrow → Today'
  ]);
  
  return { 
    success: true, 
    transferred: todayDogs.length,
    message: `Transferred ${todayDogs.length} dogs to Today`
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

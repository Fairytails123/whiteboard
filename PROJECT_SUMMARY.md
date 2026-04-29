# Fairy Tails K9 Centre - Staff Board System

## Complete Project Summary & Technical Documentation

**Last Updated:** January 2025  
**Purpose:** Digital whiteboard replacement for dog daycare operations  
**Business:** Fairy Tails K9 Centre (Dog daycare, boarding & transportation)

---

## 1. PROJECT OVERVIEW

### What It Does
The Staff Board system replaces physical whiteboards with a digital solution that:
- Displays all dogs booked for Today and Tomorrow
- Tracks photo status, walk bookings, van/parent pickup & dropoff
- Shows van stop numbers for route planning
- Displays notes from Acuity bookings
- Groups dogs by service type (Half Day AM, Full Day, Boarding)
- Auto-imports data from Acuity Scheduling daily at 2:05 PM
- Syncs between multiple devices (mobile, tablet, TV display)

### System Components
1. **Website (index.html)** - Staff interface with dual modes (Edit & Whiteboard/TV)
2. **Google Apps Script** - Backend API for Google Sheets operations
3. **Google Sheets** - Data storage (Today, Tomorrow, Settings, Import_Log tabs)
4. **n8n Workflow** - Automation that imports Acuity appointments daily

---

## 2. DATA ARCHITECTURE

### Google Sheet Structure
**Spreadsheet Tabs:**
- `Today` - Current day's dogs
- `Tomorrow` - Next day's dogs (populated by n8n)
- `Settings` - Van times configuration
- `Import_Log` - Audit trail of imports/transfers

### Column Schema (Today & Tomorrow Tabs)
```
| Column | Header           | Index | Description                              |
|--------|------------------|-------|------------------------------------------|
| A      | ID               | 0     | Unique identifier (dog_timestamp_random) |
| B      | Dog_Name         | 1     | Dog's name from Acuity forms             |
| C      | Photo            | 2     | TRUE/FALSE - photo taken today           |
| D      | Walk             | 3     | '', 'booked', or 'transferred'           |
| E      | Stop_AM          | 4     | Morning van stop number (1-20)           |
| F      | VP_AM            | 5     | Morning: V/BV/SV/DV/P (Van type/Parent)  |
| G      | VP_PM            | 6     | Evening: V/BV/SV/DV/P (Van type/Parent)  |
| H      | Stop             | 7     | Evening van stop number (1-20)           |
| I      | Notes            | 8     | Notes from Acuity appointment            |
| J      | Acuity_ID        | 9     | Original Acuity appointment ID           |
| K      | Appointment_Type | 10    | 'Full Day', 'Half Day AM', 'Boarding'    |
| L      | Crate            | 11    | Boarding crate code (HLL/HLM/HLS/HSB/HST)|
| M      | Pickup           | 12    | Grooming pickup slot                     |
| N      | Dropoff          | 13    | Grooming dropoff slot                    |
| O      | Van_Type         | 14    | Grooming van type (BV/SV/DV)             |
| P      | Check_In         | 15    | Boarding/Boarding School check-in date   |
| Q      | Check_Out        | 16    | Boarding/Boarding School check-out date  |
| R      | Crate_Size       | 17    | Boarding School crate size               |
| S      | Behaviour        | 18    | Behaviour marker (1-5), '' if unset      |
```

### Van/Parent Options
| Code | Meaning      | Colour (Website) |
|------|--------------|------------------|
| V    | Van (legacy) | Blue             |
| BV   | Big Van      | Blue             |
| SV   | Small Van    | Green            |
| DV   | Dispatch Van | Amber            |
| P    | Parent       | Purple           |

### Service Types
| Type        | Description                    | Section Colour |
|-------------|--------------------------------|----------------|
| Half Day AM | Arrives AM, leaves ~12pm       | Orange         |
| Full Day    | Arrives AM, leaves ~5pm        | Blue           |
| Boarding    | Overnight stay                 | Purple         |

---

## 3. WEBSITE (index.html)

### Features
- **Dual Mode Operation:**
  - Edit Mode: Full functionality for staff on mobile/tablet
  - Whiteboard/TV Mode: Read-only display for 40" screens, auto-refreshes
  
- **Dog Sections:** Grouped by service type with headers showing count
- **Van/Parent Controls:** AM and PM dropdowns with stop number selects (1-20)
- **Photo Checkbox:** Track which dogs have had photos taken
- **Walk Status:** None, Walk📆 (booked), Walk✅ (transferred/done)
- **Notes Field:** Displays Acuity notes, editable by staff
- **Van Times:** Configurable departure times for BV, DV, SV
- **Manual Refresh:** Orange 🔄 button to sync from Google Sheets
- **Transfer Function:** Move Tomorrow → Today with data preservation

### Race Condition Protection
**Problem:** Empty website would overwrite Google Sheet data before loading completed.

**Solution:** `initialLoadComplete` flag system:
```javascript
let state = {
    // ... other state
    initialLoadComplete: false  // Blocks all saves until data loads
};

async function autoSave() {
    // CRITICAL: Never save until initial data load is complete
    if (!state.initialLoadComplete) {
        console.log('Initial load not complete - skipping save');
        return;
    }
    // ... rest of save logic
}

async function loadBoard() {
    // ... load data from Google Sheets
    if (loadedFromSheets) {
        state.initialLoadComplete = true;  // Now safe to save
    }
}
```

### Smart Save Logic
Before saving empty data, checks if remote has data:
```javascript
if (localTodayCount === 0 && localTomorrowCount === 0) {
    // Check remote first
    const remoteData = await fetch(SCRIPT_URL + '?action=load');
    if (remoteHasData) {
        // DON'T overwrite - reload remote instead
        loadBoardSilent();
        return;
    }
}
```

### CSS Key Points
- **Mobile-first design** with breakpoints for different screen sizes
- **Stop selects:** 36px width, dropdown with options 1-20
- **VP selects:** Colour-coded backgrounds based on selection
- **TV Mode:** Larger fonts, no editing controls, auto-refresh every 60s
- **Refresh button:** Solid orange (#f59e0b) for high visibility

### Key URLs
- **Google Apps Script URL:** Set in `CONFIG.SCRIPT_URL`
- **Logo:** https://i.ibb.co/whdBKp0L/Logo-1.jpg
- **Brand Blue:** #00acee

---

## 4. GOOGLE APPS SCRIPT (google-apps-script.js)

### Deployment
- Deploy as: **Web App**
- Execute as: **Me**
- Access: **Anyone**

### API Endpoints

**GET Requests:**
| Action | Description |
|--------|-------------|
| `?action=load` | Load all data (Today, Tomorrow, Van Times) |
| `?action=loadToday` | Load Today tab only |
| `?action=loadTomorrow` | Load Tomorrow tab only |
| `?action=loadVanTimes` | Load van departure times |

**POST Requests:**
| Action | Description |
|--------|-------------|
| `action: 'save'` | Save all data |
| `action: 'saveToday'` | Save Today tab only |
| `action: 'saveTomorrow'` | Save Tomorrow tab only |
| `action: 'transfer'` | Transfer Tomorrow → Today |
| `action: 'clearTomorrow'` | Clear Tomorrow tab |

### Transfer Function Behaviour
When transferring Tomorrow → Today:
- ✅ **Preserved:** Dog name, VP_AM, VP_PM, Stop_AM, Stop, Notes, Service Type, Acuity ID
- ❌ **Reset:** Photo (set to FALSE for new day)
- 🔄 **Converted:** Walk 'transferred' → 'booked'

### Column Constants
```javascript
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
```

---

## 5. N8N WORKFLOW (acuity-staff-board-combined.json)

### Workflow Overview
**Trigger:** Daily at 14:05 (2:05 PM) + Manual trigger for testing

### Node Sequence
1. **Daily 14:05 / Manual Test** - Triggers
2. **Calculate Dates** - Gets tomorrow's date for Acuity query
3. **Fetch Appointments** - Calls Acuity API for tomorrow's bookings
4. **Extract Dog Data** - Parses appointments into dog records
5. **Dogs Found?** - IF node to check if any dogs
6. **Filter Summary** - Removes summary/debug items
7. **Write Dogs to Sheet** - Writes to Tomorrow tab
8. **Log Success/Failure** - Writes to Import_Log tab

### Acuity Parsing Logic (Node 5)

**Valid Appointment Types:**
```javascript
const VALID_TYPES = [
  'doggie day school - full day',
  'doggie day school - half day',
  'dog boarding'
];
```

**Service Type Detection:**
```javascript
if (typeName.includes('half day am')) → 'Half Day AM'
else if (typeName.includes('half day')) → 'Half Day AM' (default)
else if (typeName.includes('boarding')) → 'Boarding'
else → 'Full Day'
```

**Van Detection:**
```javascript
// Morning pickup
hasMorningVan = /morning\s*pick\s*up\s*flexi/i.test(typeString)
VP_AM = hasMorningVan ? 'V' : 'P'

// Evening dropoff (Full Day uses EVENING, Half Day uses AFTERNOON)
hasEveningVan = /evening\s*drop\s*off\s*flexi/i.test(typeString)
hasAfternoonVan = /afternoon\s*drop\s*off\s*flexi/i.test(typeString)
VP_PM = (serviceType.includes('Half Day') ? hasAfternoonVan : hasEveningVan) ? 'V' : 'P'
```

**Walk Detection:**
```javascript
if (typeString.toLowerCase().includes('sniffari')) {
    walkBooked = 'booked';
}
```

**Dog Name Extraction:**
1. First tries: `/Dog'?s?\s*Name\s*:\s*([^\n]+)/i` in formsText
2. Then tries: forms.values array for fields containing 'dog' and 'name'
3. Fallback: Uses client firstName

### Output Fields (Node 5)
```javascript
{
  ID: 'dog_' + apt.id + '_' + Date.now(),
  Dog_Name: dogName,
  Photo: 'FALSE',
  Walk: walkBooked,      // '' or 'booked'
  Stop_AM: '',           // Staff fills in
  VP_AM: vpAM,           // 'V' or 'P'
  VP_PM: vpPM,           // 'V' or 'P'
  Stop: '',              // Staff fills in
  Notes: apt.notes || '',// From Acuity
  Acuity_ID: String(apt.id),
  Appointment_Type: serviceType
}
```

### Write to Sheet (Node 7)
Column mapping matches Google Sheet exactly:
```
ID → Dog_Name → Photo → Walk → Stop_AM → VP_AM → VP_PM → Stop → Notes → Acuity_ID → Appointment_Type
```

---

## 6. KEY LEARNINGS & BEST PRACTICES

### n8n Workflow Compatibility
```javascript
// Always use these versions:
Switch node: typeVersion 3 (with rules.values array)
IF node: typeVersion 2.2 (with v3 conditions)
Google Sheets: typeVersion 4.5 or 4.6 (with __rl format)
Code node: typeVersion 2 (with jsCode parameter)

// Always include:
"pinData": {}
"settings": { "executionOrder": "v1" }
```

### Google Sheets Column Alignment
**CRITICAL:** The n8n workflow, Google Apps Script, and website must all use the same column order. If columns get misaligned:
- Notes will show wrong data (e.g., Acuity IDs)
- Data will be written to wrong columns
- Always verify column order matches across all three components

### Race Condition Prevention
1. **Never save before load completes** - Use `initialLoadComplete` flag
2. **Check remote before overwriting with empty** - Smart save logic
3. **TV Mode is read-only** - Prevents accidental data loss from display screens
4. **Retry mechanism** - If initial load fails, retry every 10 seconds

### Mobile Touch Compatibility
- Use Pointer Events API instead of HTML5 Drag and Drop
- Stop selects: Use `<select>` dropdowns instead of `<input type="number">`
- Minimum touch target: 44px × 44px for buttons

### Data Flow
```
Acuity Scheduling
       ↓
n8n Workflow (daily 2:05 PM)
       ↓
Google Sheets (Tomorrow tab)
       ↓
Website loads from Sheets
       ↓
Staff makes edits
       ↓
Website saves to Sheets
       ↓
Transfer Tomorrow → Today (manual button)
```

---

## 7. FILE LOCATIONS & DEPLOYMENT

### Files
| File | Purpose | Deploy To |
|------|---------|-----------|
| `index.html` | Staff Board website | Web hosting |
| `google-apps-script.js` | Backend API | Google Apps Script |
| `acuity-staff-board-combined.json` | Daily import | n8n Cloud |

### Google Apps Script Deployment
1. Create new Google Apps Script project
2. Paste `google-apps-script.js` content
3. Deploy → New Deployment → Web App
4. Execute as: Me, Access: Anyone
5. Copy the deployment URL to website's `CONFIG.SCRIPT_URL`

### n8n Workflow Import
1. Import JSON file
2. Set credentials:
   - `acuitySchedulingApi` - Acuity API credentials
   - `googleSheetsOAuth2Api` - Google Sheets OAuth
3. Update `documentId` in Google Sheets nodes to your spreadsheet ID
4. Activate workflow

---

## 8. CURRENT STATE & KNOWN ISSUES

### Working Features ✅
- Daily auto-import from Acuity at 2:05 PM
- Dual mode website (Edit / Whiteboard)
- Van/Parent tracking with AM/PM split
- Stop number dropdowns (1-20)
- Photo and Walk status tracking
- Service type sections (Half Day AM, Full Day, Boarding)
- Notes from Acuity appointments
- Manual refresh with visible orange button
- Transfer Tomorrow → Today with data preservation
- Race condition protection
- **Behaviour marker (1-5) per dog** — selectable on every row type (Half Day, Full Day, Boarding, Boarding School). Persisted in column S (`Behaviour`). Carries through Tomorrow → Today transfer. Amber-tinted when set.

### Configuration Points
- Van times: Configurable per day in Settings tab
- n8n schedule: Currently 14:05 daily (cron: `5 14 * * *`)
- Auto-refresh in TV mode: 60 seconds

### Known Issues Fixed (April 2026)

**Issue 1 — n8n header wipe:** The "Pull Tomorrow's Appointments" button intermittently failed at node "7. Write Dogs to Sheet" with `Could not retrieve the column data`, because node "6. Clear Tomorrow Tab" (Google Sheets `Clear` / Whole Sheet) had **Keep First Row** disabled. Each run wiped the column header row, leaving the next `Append Row` with `Map Automatically` no headers to map against. **Fix:** enabled **Keep First Row** on node 6 in the `Fairy Tails - Acuity to Staff Board` workflow.

**Issue 2 — webhook response shape:** Even after Issue 1, the button still showed `Pull failed: Workflow was started`. Cause: n8n's webhook (Respond: Immediately) returned `{"message":"Workflow was started"}`, and the website's success-detection treated any `message` field as an error. **Fix (n8n side):** added a `Response Data` value of `{"success":true,"message":"..."}` to the Webhook node so the body is now success-shaped JSON. **Fix (website side):** updated the response-handler in `index_whiteboard.html` to also recognise `Workflow was/started/triggered/queued` as success (defensive — covers the Pull Today button too).

**Webhook URLs (for reference):**
- Pull Tomorrow: `https://ftmanager.app.n8n.cloud/webhook/pull-tomorrow-staff-board`
- Pull Today: `https://ftmanager.app.n8n.cloud/webhook/pull-today-staff-board`

---

## 9. FUTURE CONSIDERATIONS

### Potential Enhancements
- Stop number auto-assignment based on route optimization
- Photo upload integration with client reports
- Real-time multi-user sync (WebSocket)
- Historical data archiving
- Client-facing status portal

### Integration Points
- JotForm for client reports (existing system)
- Telegram for staff notifications (existing system)
- RouteXL for route optimization (planned)

---

## 10. QUICK REFERENCE

### Brand Assets
- **Logo:** https://i.ibb.co/whdBKp0L/Logo-1.jpg
- **Brand Blue:** #00acee
- **Gradient:** #00acee → #007ba8

### Key Colours (Website)
| Element | Colour |
|---------|--------|
| Header gradient | #00acee → #007ba8 |
| Half Day AM section | Orange (#f97316) |
| Full Day section | Blue (#3b82f6) |
| Boarding section | Purple (#8b5cf6) |
| Van BV | Blue (#dbeafe) |
| Van SV | Green (#d1fae5) |
| Van DV | Amber (#fef3c7) |
| Parent P | Purple (#f3e8ff) |
| Refresh button | Orange (#f59e0b) |

### Testing Checklist
- [ ] n8n workflow imports successfully
- [ ] Google Apps Script deploys without errors
- [ ] Website loads data from Sheets
- [ ] Edit mode allows changes
- [ ] TV mode is read-only
- [ ] Stop dropdowns work (1-20)
- [ ] VP selections show correct colours
- [ ] Transfer button moves data correctly
- [ ] Notes display Acuity data
- [ ] No race conditions on page load

---

*Document prepared for project handoff - January 2025*

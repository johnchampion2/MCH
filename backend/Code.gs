const MCH_SHEETS = {
  USERS: ["id", "username", "email", "passwordHash", "salt", "fullName", "role", "status", "phone", "department", "photo", "createdAt", "updatedAt", "deletedAt"],
  DONORS: ["id", "date", "time", "bloodGroup", "name", "sex", "age", "units", "receiptNumber", "amount", "personnel", "createdAt", "updatedAt", "deletedAt"],
  PATIENTS: ["id", "date", "time", "bloodGroup", "issuedBloodGroup", "name", "age", "sex", "department", "units", "personnel", "createdAt", "updatedAt", "deletedAt"],
  DEPARTMENTS: ["id", "name", "active", "createdAt"],
  SETTINGS: ["key", "value", "updatedAt"],
  SESSIONS: ["tokenHash", "userId", "expiresAt", "createdAt"]
};
const MCH_BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
const MCH_LOW_STOCK_THRESHOLD = 0.30;
const MCH_SESSION_DAYS = 30;
const MCH_PASSWORD_ROUNDS = 12000;

function doGet() {
  try {
    ensureSheets_();
    return jsonOutput_({ ok: true, data: { service: "MCH-BDTMS", ready: true } });
  } catch (error) {
    return jsonOutput_({ ok: false, error: error.message || "Unable to initialize the spreadsheet." });
  }
}

function doPost(event) {
  try {
    ensureSheets_();
    const body = JSON.parse(event && event.postData && event.postData.contents || "{}");
    const result = dispatch_(body);
    return jsonOutput_({ ok: true, data: result });
  } catch (error) {
    return jsonOutput_({ ok: false, error: error.message || "The request could not be completed." });
  }
}

function setupSheets() {
  ensureSheets_(true);
  return "MCH-BDTMS sheets are ready.";
}

function authorizeMailNotifications() {
  return MailApp.getRemainingDailyQuota();
}

function dispatch_(body) {
  const action = String(body.action || "");
  if (action === "bootstrap") return { userCount: readRows_("USERS").length };
  if (action === "register") return register_(body);
  if (action === "login") return login_(body);

  if (action === "session") return { user: requireUser_(body.token) };
  if (action === "logout") return logout_(body.token);
  const user = requireUser_(body.token);

  switch (action) {
    case "dashboard": return dashboard_(user);
    case "listDonors": return readRows_("DONORS").filter(isLive_).reverse();
    case "listPatients": return readRows_("PATIENTS").filter(isLive_).reverse();
    case "getDepartments": return getDepartments_();
    case "getSettings": return { donorAmount: setting_("donorAmount", "0") };
    case "saveDonor": return saveDonor_(body, user);
    case "previewPatientIssue": return previewPatientIssue_(body);
    case "savePatient": return savePatient_(body, user);
    case "deleteDonor": return deleteRecord_("DONORS", body.id);
    case "deletePatient": return deleteRecord_("PATIENTS", body.id);
    case "getProfile": return publicUser_(user);
    case "updateProfile": return updateProfile_(body, user);
    case "listRecycleBin": return listRecycleBin_(user);
    case "restoreRecord": return restoreRecord_(body, user);
    case "permanentlyDeleteRecord": return permanentlyDeleteRecord_(body, user);
    case "emptyRecycleBin": requireAdmin_(user); return emptyRecycleBin_(user);
    case "adminOverview": requireAdmin_(user); return adminOverview_();
    case "approveUser": requireAdmin_(user); return approveUser_(body);
    case "resendApprovalEmail": requireAdmin_(user); return resendApprovalEmail_(body);
    case "setUserRole": requireAdmin_(user); return setUserRole_(body);
    case "deleteUser": requireAdmin_(user); return deleteUser_(body.id, user);
    case "addDepartment": requireAdmin_(user); return addDepartment_(body);
    case "addDepartments": requireAdmin_(user); return addDepartments_(body);
    case "updateSettings": requireAdmin_(user); return updateSettings_(body);
    default: throw new Error("Unknown request.");
  }
}

function ensureSheets_(force) {
  const cache = CacheService.getScriptCache();
  const cacheKey = "MCH_BDTMS_SHEETS_READY_V4";
  if (!force && cache.get(cacheKey) === "1") return;
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error("Bind this Apps Script project to the Google Sheet used by MCH-BDTMS.");
  Object.keys(MCH_SHEETS).forEach(function (name) {
    let sheet = spreadsheet.getSheetByName(name);
    if (!sheet) sheet = spreadsheet.insertSheet(name);
    const headers = MCH_SHEETS[name];
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.setFrozenRows(1);
      return;
    }
    const existing = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getDisplayValues()[0];
    headers.forEach(function (header) {
      if (existing.indexOf(header) === -1) {
        sheet.getRange(1, sheet.getLastColumn() + 1).setValue(header);
        existing.push(header);
      }
    });
    sheet.setFrozenRows(1);
  });
  const settings = readRows_("SETTINGS");
  if (!settings.some(function (item) { return item.key === "donorAmount"; })) {
    appendRow_("SETTINGS", { key: "donorAmount", value: "0", updatedAt: now_() });
  }
  ensureUsernames_();
  cache.put(cacheKey, "1", 300);
}

function jsonOutput_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

function getSheet_(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error("Required sheet is missing: " + name);
  return sheet;
}

function readRows_(name) {
  const sheet = getSheet_(name);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(String);
  return values.slice(1).filter(function (row) {
    return row.some(function (cell) { return cell !== "" && cell !== null; });
  }).map(function (row) {
    const record = {};
    headers.forEach(function (header, index) {
      let value = row[index];
      if (value instanceof Date) value = Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd");
      record[header] = value == null ? "" : value;
    });
    return record;
  });
}

function appendRow_(name, record) {
  const sheet = getSheet_(name);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  sheet.appendRow(headers.map(function (header) {
    return Object.prototype.hasOwnProperty.call(record, header) ? record[header] : "";
  }));
}

function updateRow_(name, id, updates) {
  const sheet = getSheet_(name);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) throw new Error("Record not found.");
  const headers = values[0].map(String);
  const idIndex = headers.indexOf("id");
  const rowIndex = values.findIndex(function (row, index) { return index > 0 && String(row[idIndex]) === String(id); });
  if (rowIndex < 1) throw new Error("Record not found.");
  Object.keys(updates).forEach(function (key) {
    const column = headers.indexOf(key);
    if (column !== -1) sheet.getRange(rowIndex + 1, column + 1).setValue(updates[key]);
  });
}

function activeOrPending_(user) {
  return user.status === "ACTIVE" || user.status === "PENDING";
}

function isLive_(record) {
  return !record.deletedAt;
}

function now_() {
  return new Date().toISOString();
}

function newId_() {
  return Utilities.getUuid();
}

function normalizeEmail_(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeUsername_(username) {
  return String(username || "").trim().toLowerCase();
}

function validateUsername_(value) {
  const username = normalizeUsername_(cleanText_(value, "Username", 30, true));
  if (!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(username)) {
    throw new Error("Username must be 3 to 30 characters and use only letters, numbers, dots, underscores, or hyphens.");
  }
  return username;
}

function usernameFromEmail_(email, usedUsernames) {
  let base = String(email || "").split("@")[0].toLowerCase().replace(/[^a-z0-9._-]/g, "").replace(/^[._-]+|[._-]+$/g, "");
  if (base.length < 3) base = (base + "user").slice(0, 30);
  base = base.slice(0, 30);
  let candidate = base;
  let suffix = 2;
  while (usedUsernames[candidate]) {
    const digits = String(suffix);
    candidate = base.slice(0, 30 - digits.length) + digits;
    suffix += 1;
  }
  return candidate;
}

function ensureUsernames_() {
  const usedUsernames = Object.create(null);
  readRows_("USERS").forEach(function (user) {
    let username = normalizeUsername_(user.username);
    if (!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(username) || usedUsernames[username]) {
      username = usernameFromEmail_(user.email, usedUsernames);
      updateRow_("USERS", user.id, { username: username });
    }
    usedUsernames[username] = true;
  });
}

function cleanText_(value, label, maxLength, required) {
  const text = String(value == null ? "" : value).trim();
  if (required && !text) throw new Error(label + " is required.");
  if (text.length > maxLength) throw new Error(label + " is too long.");
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) throw new Error(label + " contains invalid characters.");
  return text;
}

function randomSalt_() {
  return Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
}

function passwordHash_(password, salt) {
  let block = Utilities.computeHmacSha256Signature(salt + "\u0000\u0000\u0000\u0001", password, Utilities.Charset.UTF_8);
  const result = block.slice();
  for (let round = 1; round < MCH_PASSWORD_ROUNDS; round += 1) {
    block = Utilities.computeHmacSha256Signature(Utilities.base64Encode(block), password, Utilities.Charset.UTF_8);
    for (let index = 0; index < result.length; index += 1) result[index] ^= block[index];
  }
  return result.map(function (byte) {
    const value = (byte + 256) % 256;
    return ("0" + value.toString(16)).slice(-2);
  }).join("");
}

function register_(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const fullName = cleanText_(body.fullName, "Full name", 100, true);
    const username = validateUsername_(body.username);
    const email = normalizeEmail_(body.email);
    const password = String(body.password || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 150) throw new Error("Enter a valid email address.");
    if (password.length < 8 || password.length > 128) throw new Error("Password must contain 8 to 128 characters.");
    const users = readRows_("USERS");
    if (users.some(function (user) { return normalizeEmail_(user.email) === email && !user.deletedAt; })) {
      throw new Error("An account with this email already exists.");
    }
    if (users.some(function (user) { return normalizeUsername_(user.username) === username; })) {
      throw new Error("An account with this username already exists.");
    }
    const isFirst = users.length === 0;
    const salt = randomSalt_();
    const record = {
      id: newId_(), username: username, email: email, passwordHash: passwordHash_(password, salt), salt: salt,
      fullName: fullName, role: isFirst ? "Administrator" : "Lab Technician",
      status: isFirst ? "ACTIVE" : "PENDING", phone: cleanText_(body.phone, "Phone number", 30, false),
      department: "", photo: "", createdAt: now_(), updatedAt: now_(), deletedAt: ""
    };
    appendRow_("USERS", record);
    return { status: record.status, role: record.role };
  } finally {
    lock.releaseLock();
  }
}

function login_(body) {
  const username = normalizeUsername_(body.username);
  const password = String(body.password || "");
  const role = String(body.role || "");
  const user = readRows_("USERS").find(function (item) {
    return normalizeUsername_(item.username) === username && !item.deletedAt;
  });
  if (!user || !user.salt || passwordHash_(password, String(user.salt)) !== String(user.passwordHash) ||
      ["Administrator", "Lab Technician"].indexOf(role) === -1 || user.role !== role) {
    throw new Error("Username, password, or role is incorrect.");
  }
  if (user.status !== "ACTIVE") {
    throw new Error(user.status === "PENDING" ? "Your account is awaiting Administrator approval." : "This account is not active.");
  }
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, "");
  appendRow_("SESSIONS", {
    tokenHash: tokenHash_(token), userId: user.id,
    expiresAt: new Date(Date.now() + MCH_SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    createdAt: now_()
  });
  return { token: token, user: publicUser_(user) };
}

function requireUser_(token) {
  if (!token || String(token).length < 30) throw new Error("Please sign in to continue.");
  const hash = tokenHash_(token);
  const session = readRows_("SESSIONS").find(function (item) {
    return item.tokenHash === hash && new Date(item.expiresAt).getTime() > Date.now();
  });
  if (!session) throw new Error("Your session has expired. Please sign in again.");
  const user = readRows_("USERS").find(function (item) {
    return item.id === session.userId && item.status === "ACTIVE" && !item.deletedAt;
  });
  if (!user) throw new Error("This account is no longer active.");
  return user;
}

function logout_(token) {
  if (!token) return { signedOut: true };
  const hash = tokenHash_(token);
  const session = readRows_("SESSIONS").find(function (item) { return item.tokenHash === hash; });
  if (session) {
    const sheet = getSheet_("SESSIONS");
    const values = sheet.getDataRange().getValues();
    const headers = values[0].map(String);
    const tokenColumn = headers.indexOf("tokenHash");
    const rowIndex = values.findIndex(function (row, index) { return index > 0 && row[tokenColumn] === hash; });
    if (rowIndex > 0) sheet.getRange(rowIndex + 1, tokenColumn + 1).setValue("");
  }
  return { signedOut: true };
}

function tokenHash_(token) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(token), Utilities.Charset.UTF_8);
  return bytes.map(function (byte) {
    const value = (byte + 256) % 256;
    return ("0" + value.toString(16)).slice(-2);
  }).join("");
}

function publicUser_(user) {
  return {
    id: String(user.id), username: String(user.username || ""), email: String(user.email), fullName: String(user.fullName),
    role: String(user.role), status: String(user.status), phone: String(user.phone || ""),
    department: String(user.department || ""), photo: String(user.photo || "")
  };
}

function requireAdmin_(user) {
  if (user.role !== "Administrator") throw new Error("Administrator access is required.");
}

function dashboard_(user) {
  const donors = readRows_("DONORS").filter(isLive_);
  const patients = readRows_("PATIENTS").filter(isLive_);
  const departments = getDepartments_();
  const stats = {
    totalDonors: donors.length, totalPatients: patients.length,
    maleDonors: donors.filter(function (item) { return item.sex === "Male"; }).length,
    femaleDonors: donors.filter(function (item) { return item.sex === "Female"; }).length,
    malePatients: patients.filter(function (item) { return item.sex === "Male"; }).length,
    femalePatients: patients.filter(function (item) { return item.sex === "Female"; }).length,
    unitsReceived: donors.reduce(function (sum, item) { return sum + number_(item.units); }, 0),
    unitsIssued: patients.reduce(function (sum, item) { return sum + number_(item.units); }, 0),
    departments: departments.length,
    donorAmounts: donors.reduce(function (sum, item) { return sum + number_(item.amount); }, 0)
  };
  stats.availableUnits = stats.unitsReceived - stats.unitsIssued;
  const bloodGroups = bloodGroupStock_(donors, patients);
  const departmentMap = {};
  patients.forEach(function (item) {
    const name = String(item.department || "Unassigned");
    departmentMap[name] = (departmentMap[name] || 0) + number_(item.units);
  });
  return {
    stats: stats, bloodGroups: bloodGroups,
    departmentUsage: Object.keys(departmentMap).map(function (department) { return { department: department, units: departmentMap[department] }; }),
    recentDonors: donors.slice(-5).reverse().map(function (item) { return { name: item.name, bloodGroup: item.bloodGroup, units: item.units, date: item.date }; })
  };
}

function bloodGroupStock_(donors, patients) {
  return MCH_BLOOD_GROUPS.map(function (group) {
    const received = donors.filter(function (item) { return item.bloodGroup === group; })
      .reduce(function (sum, item) { return sum + number_(item.units); }, 0);
    const issued = patients.filter(function (item) { return issuedBloodGroup_(item) === group; })
      .reduce(function (sum, item) { return sum + number_(item.units); }, 0);
    const available = received - issued;
    return {
      group: group, units: available, available: Math.max(0, available), received: received, issued: issued,
      remainingPercent: received ? Math.max(0, available) / received * 100 : 0,
      lowStock: received > 0 && Math.max(0, available) / received <= MCH_LOW_STOCK_THRESHOLD
    };
  });
}

function issuedBloodGroup_(patient) {
  return String(patient.issuedBloodGroup || patient.bloodGroup || "");
}

function number_(value) {
  const parsed = Number(String(value == null ? "" : value).replace(/,/g, ""));
  return isFinite(parsed) ? parsed : 0;
}

function validateRecord_(body, includeDepartment) {
  const name = cleanText_(body.name, "Name", 100, true);
  const date = cleanText_(body.date, "Date", 10, true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Enter a valid date.");
  const time = cleanText_(body.time, "Time", 5, true);
  const bloodGroup = cleanText_(body.bloodGroup, "Blood group", 3, true);
  if (MCH_BLOOD_GROUPS.indexOf(bloodGroup) === -1) throw new Error("Select a valid blood group.");
  const sex = cleanText_(body.sex, "Sex", 10, true);
  if (["Male", "Female"].indexOf(sex) === -1) throw new Error("Select a valid sex.");
  const units = number_(body.units);
  if (!Number.isInteger(units) || units < 1 || units > 1000) throw new Error("Blood units must be a whole number from 1 to 1,000.");
  const age = body.age === "" || body.age == null ? "" : number_(body.age);
  if (age !== "" && (!Number.isInteger(age) || age < 0 || age > 120)) throw new Error("Enter a valid age.");
  const record = { date: date, time: time, bloodGroup: bloodGroup, name: name, sex: sex, age: age, units: units };
  if (includeDepartment) record.department = cleanText_(body.department, "Department", 100, true);
  return record;
}

function saveDonor_(body, user) {
  const record = validateRecord_(body, false);
  record.receiptNumber = cleanText_(body.receiptNumber, "Receipt number", 50, false);
  record.personnel = String(user.fullName);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (body.id) {
      const existing = readRows_("DONORS").find(function (item) { return item.id === body.id && !item.deletedAt; });
      if (!existing) throw new Error("Donor record not found.");
      if (String(existing.bloodGroup) !== record.bloodGroup || number_(existing.units) !== record.units) {
        const affectedGroups = [existing.bloodGroup, record.bloodGroup];
        affectedGroups.forEach(function (group) {
          const available = availableBloodUnits_(group, "", existing.id) +
            (record.bloodGroup === group ? record.units : 0);
          if (available < 0) {
            throw new Error("This change would leave " + Math.abs(available) + " issued " + group +
              " unit(s) without a matching donation.");
          }
        });
      }
      record.personnel = existing.personnel || record.personnel;
      record.updatedAt = now_();
      updateRow_("DONORS", body.id, record);
      return { id: body.id, updated: true };
    }
    record.id = newId_();
    record.amount = number_(setting_("donorAmount", "0"));
    record.createdAt = now_();
    record.updatedAt = now_();
    record.deletedAt = "";
    appendRow_("DONORS", record);
    return { id: record.id };
  } finally {
    lock.releaseLock();
  }
}

function savePatient_(body, user) {
  const record = validateRecord_(body, true);
  if (!getDepartments_().some(function (department) { return department.name === record.department; })) {
    throw new Error("Select an active department from the list.");
  }
  record.personnel = String(user.fullName);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (body.id) {
      const existing = readRows_("PATIENTS").find(function (item) { return item.id === body.id && !item.deletedAt; });
      if (!existing) throw new Error("Patient record not found.");
      const allocation = choosePatientBlood_(record.bloodGroup, record.units, body.id);
      if (!allocation.available) throw new Error(allocation.message);
      record.issuedBloodGroup = allocation.issuedBloodGroup;
      record.personnel = existing.personnel || record.personnel;
      record.updatedAt = now_();
      updateRow_("PATIENTS", body.id, record);
      return {
        id: body.id,
        updated: true,
        patientBloodGroup: record.bloodGroup,
        issuedBloodGroup: record.issuedBloodGroup,
        allocationMessage: allocation.message
      };
    }
    const allocation = choosePatientBlood_(record.bloodGroup, record.units, "");
    if (!allocation.available) throw new Error(allocation.message);
    record.issuedBloodGroup = allocation.issuedBloodGroup;
    record.id = newId_();
    record.createdAt = now_();
    record.updatedAt = now_();
    record.deletedAt = "";
    appendRow_("PATIENTS", record);
    return {
      id: record.id,
      patientBloodGroup: record.bloodGroup,
      issuedBloodGroup: record.issuedBloodGroup,
      allocationMessage: allocation.message
    };
  } finally {
    lock.releaseLock();
  }
}

function previewPatientIssue_(body) {
  const bloodGroup = String(body.bloodGroup || "");
  const units = number_(body.units);
  if (MCH_BLOOD_GROUPS.indexOf(bloodGroup) === -1) throw new Error("Select a valid patient blood group.");
  if (!Number.isInteger(units) || units < 1) throw new Error("Enter a whole number of blood units.");
  return choosePatientBlood_(bloodGroup, units, String(body.id || ""));
}

function deleteRecord_(sheetName, id) {
  if (!id) throw new Error("Record ID is required.");
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const record = readRows_(sheetName).find(function (item) { return item.id === id && !item.deletedAt; });
    if (!record) throw new Error("Record not found.");
    if (sheetName === "DONORS") {
      const availableAfterDelete = availableBloodUnits_(record.bloodGroup, "", record.id);
      if (availableAfterDelete < 0) {
        throw new Error("Cannot delete this donor record: " + Math.abs(availableAfterDelete) +
          " " + record.bloodGroup + " unit(s) have already been issued.");
      }
    }
    updateRow_(sheetName, id, { deletedAt: now_() });
    return { deleted: true };
  } finally {
    lock.releaseLock();
  }
}

function availableBloodUnits_(bloodGroup, excludePatientId, excludeDonorId) {
  const received = readRows_("DONORS").filter(function (item) {
    return isLive_(item) && item.bloodGroup === bloodGroup && item.id !== excludeDonorId;
  }).reduce(function (sum, item) { return sum + number_(item.units); }, 0);
  const issued = readRows_("PATIENTS").filter(function (item) {
    return isLive_(item) && issuedBloodGroup_(item) === bloodGroup && item.id !== excludePatientId;
  }).reduce(function (sum, item) { return sum + number_(item.units); }, 0);
  return received - issued;
}

function canDonateRedCells_(donorGroup, recipientGroup) {
  const donorAbo = donorGroup.slice(0, -1);
  const recipientAbo = recipientGroup.slice(0, -1);
  const aboCompatible = donorAbo === "O" || donorAbo === recipientAbo ||
    (donorAbo === "A" && recipientAbo === "AB") ||
    (donorAbo === "B" && recipientAbo === "AB");
  const rhCompatible = donorGroup.slice(-1) === "-" || recipientGroup.slice(-1) === "+";
  return aboCompatible && rhCompatible;
}

function choosePatientBlood_(recipientGroup, units, excludePatientId) {
  const donors = readRows_("DONORS").filter(isLive_);
  const patients = readRows_("PATIENTS").filter(function (item) {
    return isLive_(item) && item.id !== excludePatientId;
  });
  const stock = bloodGroupStock_(donors, patients);
  const exact = stock.find(function (item) { return item.group === recipientGroup; });
  if (exact && exact.available >= units) {
    return {
      available: true,
      patientBloodGroup: recipientGroup,
      issuedBloodGroup: recipientGroup,
      message: units + " " + (units === 1 ? "unit" : "units") + " of " + recipientGroup + " blood " +
        (units === 1 ? "is" : "are") + " available and will be issued."
    };
  }

  const compatible = stock.filter(function (item) {
    return item.available >= units && canDonateRedCells_(item.group, recipientGroup);
  }).sort(function (a, b) {
    const priority = function (group) {
      if (group === recipientGroup) return 0;
      if (group === "O-") return 3;
      return group.slice(-1) === recipientGroup.slice(-1) ? 1 : 2;
    };
    return priority(a.group) - priority(b.group) ||
      b.available - a.available ||
      MCH_BLOOD_GROUPS.indexOf(a.group) - MCH_BLOOD_GROUPS.indexOf(b.group);
  });

  if (compatible.length) {
    const selected = compatible[0];
    const exactCount = exact ? exact.available : 0;
    const exactStatus = exactCount
      ? "Only " + exactCount + " " + (exactCount === 1 ? "unit" : "units") + " of " + recipientGroup +
        " blood " + (exactCount === 1 ? "is" : "are") + " available for the requested " + units + ". "
      : "No " + recipientGroup + " blood is available. ";
    return {
      available: true,
      patientBloodGroup: recipientGroup,
      issuedBloodGroup: selected.group,
      message: exactStatus + "Compatible " + selected.group + " blood will be issued; the patient's blood group remains " +
        recipientGroup + "."
    };
  }

  const compatibleStock = stock.filter(function (item) {
    return canDonateRedCells_(item.group, recipientGroup);
  }).map(function (item) {
    return item.group + ": " + Math.max(0, item.available);
  }).join(", ");
  return {
    available: false,
    patientBloodGroup: recipientGroup,
    issuedBloodGroup: "",
    message: "There is not enough compatible stock for patient blood group " + recipientGroup + ". " +
      "A single compatible group must cover all " + units + " requested " + (units === 1 ? "unit" : "units") +
      ". Available compatible units by group: " + (compatibleStock || "none") + "."
  };
}

function getDepartments_() {
  return readRows_("DEPARTMENTS").filter(function (item) { return String(item.active) !== "false" && String(item.active) !== "FALSE" && !item.deletedAt; });
}

function setting_(key, fallback) {
  const item = readRows_("SETTINGS").find(function (row) { return row.key === key; });
  return item ? String(item.value) : fallback;
}

function adminOverview_() {
  return {
    users: readRows_("USERS").filter(function (user) { return activeOrPending_(user) && !user.deletedAt; }).map(publicUser_),
    departments: getDepartments_(),
    donorAmount: setting_("donorAmount", "0")
  };
}

function approveUser_(body) {
  const user = readRows_("USERS").find(function (item) { return item.id === body.id && !item.deletedAt; });
  if (!user || user.status !== "PENDING") throw new Error("Pending user not found.");
  const role = body.role === "Administrator" ? "Administrator" : "Lab Technician";
  updateRow_("USERS", user.id, { status: "ACTIVE", role: role, updatedAt: now_() });
  return Object.assign({ approved: true }, sendApprovalEmail_(user, role));
}

function resendApprovalEmail_(body) {
  const user = readRows_("USERS").find(function (item) {
    return item.id === body.id && item.status === "ACTIVE" && !item.deletedAt;
  });
  if (!user) throw new Error("Active user not found.");
  return Object.assign({ approved: true }, sendApprovalEmail_(user, user.role));
}

function sendApprovalEmail_(user, role) {
  try {
    const fullName = String(user.fullName || "MCH-BDTMS user");
    const safeName = escapeEmailHtml_(fullName);
    const username = String(user.username || "");
    const safeUsername = escapeEmailHtml_(username);
    const safeRole = escapeEmailHtml_(role);
    MailApp.sendEmail({
      to: String(user.email),
      subject: "MCH-BDTMS | Your account has been approved",
      name: "Magbenteh Community Hospital",
      body: "Hello " + fullName + ",\n\nYour Magbenteh Community Hospital Blood Donation and Transfusion Management System account is now active.\n\nUsername: " +
        username + "\nRole: " + String(role) + "\nYou can now sign in using the MCH-BDTMS link shared with you by the hospital.\n\nMagbenteh Community Hospital",
      htmlBody: '<!doctype html><html><body style="margin:0;padding:0;background:#f2f5f8;font-family:Arial,Helvetica,sans-serif;color:#17212b">' +
        '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f2f5f8;padding:32px 12px"><tr><td align="center">' +
        '<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:#fff;border:1px solid #e3e9ef;border-radius:12px;overflow:hidden">' +
        '<tr><td style="padding:25px 32px;background:#152b3e;border-bottom:4px solid #d7a64b;color:#fff">' +
        '<div style="font-size:12px;font-weight:bold;letter-spacing:1.6px;color:#f2cd84">MAGBENTEH COMMUNITY HOSPITAL</div>' +
        '<div style="padding-top:7px;font-size:15px;line-height:1.5">Blood Donation &amp; Transfusion Management System</div></td></tr>' +
        '<tr><td style="padding:34px 32px 28px">' +
        '<div style="display:inline-block;padding:7px 11px;border-radius:20px;background:#eaf5ee;color:#267348;font-size:11px;font-weight:bold;letter-spacing:.8px">ACCOUNT APPROVED</div>' +
        '<h1 style="margin:18px 0 12px;font-size:25px;line-height:1.25;color:#17212b">You are ready to get started</h1>' +
        '<p style="margin:0 0 13px;font-size:15px;line-height:1.7">Hello ' + safeName + ',</p>' +
        '<p style="margin:0 0 20px;color:#526170;font-size:14px;line-height:1.7">Your MCH-BDTMS account is now active. You can sign in using the system link shared with you by the hospital.</p>' +
        '<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;margin:0 0 22px;background:#f5f7fa;border-left:3px solid #a31424;border-radius:5px">' +
        '<tr><td style="padding:13px 15px"><div style="color:#718092;font-size:10px;font-weight:bold;letter-spacing:1px">USERNAME</div>' +
        '<div style="padding-top:5px;color:#17212b;font-size:14px;font-weight:bold">' + safeUsername + '</div>' +
        '<div style="padding-top:13px;color:#718092;font-size:10px;font-weight:bold;letter-spacing:1px">YOUR ROLE</div>' +
        '<div style="padding-top:5px;color:#17212b;font-size:14px;font-weight:bold">' + safeRole + '</div></td></tr></table>' +
        '<p style="margin:0;color:#526170;font-size:13px;line-height:1.7">If you have questions, please contact your MCH-BDTMS Administrator.</p></td></tr>' +
        '<tr><td style="padding:17px 32px;background:#f7f9fb;border-top:1px solid #e3e9ef;color:#718092;font-size:11px;line-height:1.6">' +
        'Magbenteh Community Hospital<br>This is an automated account notification. Please do not reply to this email.</td></tr>' +
        '</table></td></tr></table></body></html>'
    });
    return { emailSent: true, emailError: "" };
  } catch (error) {
    const message = String(error && error.message ? error.message : "The approval email could not be sent.");
    const emailError = /permission to call|authorization is required|not authorized/i.test(message) ?
      "Email permission is not authorized. Run authorizeMailNotifications() in the Apps Script editor, approve the mail permission, then deploy a new version." :
      message;
    return { emailSent: false, emailError: emailError };
  }
}

function escapeEmailHtml_(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function (character) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
  });
}

function setUserRole_(body) {
  const role = String(body.role || "");
  if (["Administrator", "Lab Technician"].indexOf(role) === -1) throw new Error("Select a valid user role.");
  const user = readRows_("USERS").find(function (item) { return item.id === body.id && item.status === "ACTIVE" && !item.deletedAt; });
  if (!user) throw new Error("Active user not found.");
  if (user.role === "Administrator" && role !== "Administrator" && activeAdminCount_() <= 1) {
    throw new Error("At least one active Administrator must remain.");
  }
  updateRow_("USERS", user.id, { role: role, updatedAt: now_() });
  return { updated: true };
}

function activeAdminCount_() {
  return readRows_("USERS").filter(function (item) {
    return item.role === "Administrator" && item.status === "ACTIVE" && !item.deletedAt;
  }).length;
}

function deleteUser_(id, currentUser) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const target = readRows_("USERS").find(function (item) { return item.id === id && !item.deletedAt && activeOrPending_(item); });
    if (!target) throw new Error("User account not found.");
    if (target.role === "Administrator" && activeAdminCount_() <= 1) {
      throw new Error("The last active Administrator cannot be deleted.");
    }
    updateRow_("USERS", target.id, { status: "DELETED", deletedAt: now_(), updatedAt: now_() });
    return { deleted: true, self: target.id === currentUser.id };
  } finally {
    lock.releaseLock();
  }
}

function addDepartment_(body) {
  const department = addDepartments_({ names: [body.name] }).departments[0];
  return { id: department.id, name: department.name };
}

function addDepartments_(body) {
  if (!Array.isArray(body.names) || !body.names.length || body.names.length > 20) {
    throw new Error("Add between 1 and 20 departments at a time.");
  }
  const names = body.names.map(function (value) { return cleanText_(value, "Department name", 100, true); });
  const seen = Object.create(null);
  names.forEach(function (name) {
    const key = name.toLowerCase();
    if (seen[key]) throw new Error("Each department name must be unique.");
    seen[key] = true;
  });
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const existing = getDepartments_();
    if (names.some(function (name) {
      return existing.some(function (item) { return String(item.name).toLowerCase() === name.toLowerCase(); });
    })) {
      throw new Error("One or more departments already exist.");
    }
    const created = names.map(function (name) {
      return { id: newId_(), name: name, active: true, createdAt: now_() };
    });
    const sheet = getSheet_("DEPARTMENTS");
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
    const rows = created.map(function (record) {
      return headers.map(function (header) { return Object.prototype.hasOwnProperty.call(record, header) ? record[header] : ""; });
    });
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
    return { departments: created, count: created.length };
  } finally {
    lock.releaseLock();
  }
}

function updateSettings_(body) {
  const amount = number_(body.donorAmount);
  if (!isFinite(amount) || amount < 0 || amount > 1000000000) throw new Error("Enter a valid donor amount.");
  const rows = readRows_("SETTINGS");
  const current = rows.find(function (item) { return item.key === "donorAmount"; });
  if (current) updateRowByKey_("SETTINGS", "key", "donorAmount", { value: String(amount), updatedAt: now_() });
  else appendRow_("SETTINGS", { key: "donorAmount", value: String(amount), updatedAt: now_() });
  return { donorAmount: String(amount) };
}

function updateRowByKey_(sheetName, keyName, keyValue, updates) {
  const sheet = getSheet_(sheetName);
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(String);
  const keyIndex = headers.indexOf(keyName);
  const rowIndex = values.findIndex(function (row, index) { return index > 0 && String(row[keyIndex]) === String(keyValue); });
  if (rowIndex < 1) throw new Error("Setting not found.");
  Object.keys(updates).forEach(function (key) {
    const column = headers.indexOf(key);
    if (column !== -1) sheet.getRange(rowIndex + 1, column + 1).setValue(updates[key]);
  });
}

function updateProfile_(body, currentUser) {
  const fullName = cleanText_(body.fullName, "Full name", 100, true);
  const username = validateUsername_(body.username);
  const email = normalizeEmail_(body.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 150) throw new Error("Enter a valid email address.");
  const users = readRows_("USERS");
  if (users.some(function (item) { return item.id !== currentUser.id && normalizeEmail_(item.email) === email && !item.deletedAt; })) {
    throw new Error("Another account already uses this email.");
  }
  if (users.some(function (item) { return item.id !== currentUser.id && normalizeUsername_(item.username) === username; })) {
    throw new Error("Another account already uses this username.");
  }
  const photo = body.removePhoto === true ? "" : String(body.photo || currentUser.photo || "");
  if (photo.length > 45000) throw new Error("Profile photo is too large to store in Google Sheets. Choose another image.");
  if (photo && !/^data:image\/jpeg;base64,/.test(photo)) throw new Error("Profile photo must be a JPEG image.");
  updateRow_("USERS", currentUser.id, {
    fullName: fullName, username: username, email: email, phone: cleanText_(body.phone, "Phone number", 30, false),
    department: cleanText_(body.department, "Department", 100, false),
    photo: photo, updatedAt: now_()
  });
  const updated = readRows_("USERS").find(function (item) { return item.id === currentUser.id; });
  return publicUser_(updated);
}

function listRecycleBin_(user) {
  const result = [];
  ["DONORS", "PATIENTS", "USERS"].forEach(function (sheetName) {
    readRows_(sheetName).filter(function (item) { return Boolean(item.deletedAt); }).forEach(function (item) {
      result.push({
        type: sheetName === "DONORS" ? "Donor" : sheetName === "PATIENTS" ? "Patient" : "User",
        id: String(item.id), label: String(item.name || item.fullName || item.email || "Deleted record"),
        deletedAt: String(item.deletedAt)
      });
    });
  });
  return result.sort(function (a, b) { return String(b.deletedAt).localeCompare(String(a.deletedAt)); });
}

function restoreRecord_(body, user) {
  requireAdmin_(user);
  const map = { Donor: "DONORS", Patient: "PATIENTS", User: "USERS" };
  const sheetName = map[String(body.type)];
  if (!sheetName) throw new Error("Record type is invalid.");
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const record = readRows_(sheetName).find(function (item) { return item.id === body.id && item.deletedAt; });
    if (!record) throw new Error("Deleted record not found.");
    let patientAllocation = null;
    if (sheetName === "PATIENTS") {
      patientAllocation = choosePatientBlood_(record.bloodGroup, number_(record.units), "");
      if (!patientAllocation.available) throw new Error(patientAllocation.message);
    }
    if (sheetName === "USERS" && record.status === "DELETED") {
      updateRow_(sheetName, record.id, { status: "PENDING", deletedAt: "", updatedAt: now_() });
    } else {
      updateRow_(sheetName, record.id, patientAllocation
        ? { deletedAt: "", issuedBloodGroup: patientAllocation.issuedBloodGroup, updatedAt: now_() }
        : { deletedAt: "" });
    }
    return patientAllocation
      ? {
        restored: true,
        patientBloodGroup: record.bloodGroup,
        issuedBloodGroup: patientAllocation.issuedBloodGroup,
        allocationMessage: patientAllocation.message
      }
      : { restored: true };
  } finally {
    lock.releaseLock();
  }
}

function permanentlyDeleteRecord_(body, user) {
  requireAdmin_(user);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const map = { Donor: "DONORS", Patient: "PATIENTS", User: "USERS" };
    const sheetName = map[String(body.type)];
    if (!sheetName) throw new Error("Record type is invalid.");
    const sheet = getSheet_(sheetName);
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) throw new Error("Deleted record not found.");
    const headers = values[0].map(String);
    const idColumn = headers.indexOf("id");
    const deletedColumn = headers.indexOf("deletedAt");
    if (idColumn < 0 || deletedColumn < 0) throw new Error("Record sheet is missing required columns.");
    const rowIndex = values.findIndex(function (row, index) {
      return index > 0 && String(row[idColumn]) === String(body.id) && Boolean(row[deletedColumn]);
    });
    if (rowIndex < 1) throw new Error("Deleted record not found.");
    const deletedRecord = {};
    headers.forEach(function (header, index) { deletedRecord[header] = values[rowIndex][index]; });
    if (sheetName === "USERS") deleteUserSessions_(String(deletedRecord.id));
    sheet.deleteRow(rowIndex + 1);
    return { permanentlyDeleted: true };
  } finally {
    lock.releaseLock();
  }
}

function emptyRecycleBin_(user) {
  requireAdmin_(user);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheetNames = ["DONORS", "PATIENTS", "USERS"];
    const targets = [];
    const deletedUserIds = [];
    const counts = { donors: 0, patients: 0, users: 0 };
    sheetNames.forEach(function (sheetName) {
      const sheet = getSheet_(sheetName);
      const values = sheet.getDataRange().getValues();
      if (values.length < 2) return;
      const headers = values[0].map(String);
      const deletedColumn = headers.indexOf("deletedAt");
      if (deletedColumn < 0) throw new Error(sheetName + " sheet is missing the deletedAt column.");
      const idColumn = headers.indexOf("id");
      const rows = [];
      for (let index = 1; index < values.length; index += 1) {
        if (!values[index][deletedColumn]) continue;
        rows.push(index + 1);
        if (sheetName === "USERS") {
          if (idColumn < 0) throw new Error("USERS sheet is missing the id column.");
          deletedUserIds.push(String(values[index][idColumn]));
        }
      }
      const key = sheetName.toLowerCase();
      counts[key] = rows.length;
      if (rows.length) targets.push({ sheet: sheet, rows: rows });
    });

    deleteUserSessionsForUsers_(deletedUserIds);
    targets.forEach(function (target) { deleteRowsDescending_(target.sheet, target.rows); });
    return {
      deletedCounts: counts,
      totalDeleted: counts.donors + counts.patients + counts.users
    };
  } finally {
    lock.releaseLock();
  }
}

function deleteUserSessionsForUsers_(userIds) {
  if (!userIds.length) return;
  const deletedUsers = {};
  userIds.forEach(function (id) { deletedUsers[String(id)] = true; });
  const sheet = getSheet_("SESSIONS");
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return;
  const userColumn = values[0].map(String).indexOf("userId");
  if (userColumn < 0) throw new Error("Session sheet is missing the userId column.");
  const rows = [];
  for (let index = 1; index < values.length; index += 1) {
    if (deletedUsers[String(values[index][userColumn])]) rows.push(index + 1);
  }
  deleteRowsDescending_(sheet, rows);
}

function deleteRowsDescending_(sheet, rowNumbers) {
  const rows = rowNumbers.slice().sort(function (a, b) { return a - b; });
  let deleted = 0;
  let index = rows.length - 1;
  while (index >= 0) {
    let start = rows[index];
    const end = start;
    index -= 1;
    while (index >= 0 && rows[index] === start - 1) {
      start = rows[index];
      index -= 1;
    }
    const count = end - start + 1;
    sheet.deleteRows(start, count);
    deleted += count;
  }
  return deleted;
}

function deleteUserSessions_(userId) {
  const sheet = getSheet_("SESSIONS");
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return;
  const headers = values[0].map(String);
  const userColumn = headers.indexOf("userId");
  if (userColumn < 0) throw new Error("Session sheet is missing the userId column.");
  for (let index = values.length - 1; index > 0; index -= 1) {
    if (String(values[index][userColumn]) === userId) sheet.deleteRow(index + 1);
  }
}

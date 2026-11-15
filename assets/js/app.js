(function () {
  "use strict";

  const config = window.MCH_BDTMS_CONFIG || {};
  const imagePaths = [
    "assets/images/hospital-01.png",
    "assets/images/hospital-02.png",
    "assets/images/hospital-03.png",
    "assets/images/hospital-04.png",
    "assets/images/hospital-05.png"
  ];
  const savedToken = localStorage.getItem("mchToken") || sessionStorage.getItem("mchToken") || "";
  if (savedToken) localStorage.setItem("mchToken", savedToken);
  sessionStorage.removeItem("mchToken");
  const state = { token: savedToken, user: null, page: "home", reportTab: "statistics", cache: {} };
  const readActions = new Set(["bootstrap", "listDonors", "listPatients", "getDepartments", "getSettings", "dashboard", "adminOverview", "getProfile", "listRecycleBin", "previewPatientIssue"]);
  const responseCache = new Map();
  const pendingRequests = new Map();
  const responseCacheTtl = 15000;
  const $ = (selector, root) => (root || document).querySelector(selector);
  const $$ = (selector, root) => Array.from((root || document).querySelectorAll(selector));
  const escapeHtml = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
  const money = (value) => "Le " + Number(value || 0).toLocaleString("en-US");
  const today = () => new Date().toISOString().slice(0, 10);
  const dateLabel = (value) => value ? new Date(value + "T00:00:00").toLocaleDateString() : "—";
  let toastTimer;
  let patientPreviewTimer;
  let patientPreviewRequestId = 0;
  let connectionStatus = "checking";
  let connectionCheckPromise = null;
  let connectionRecoveryRequested = false;
  let deferredInstallPrompt = null;
  const installStateKey = "mchBdtmsInstalled";
  let authRotationTimer = null;
  let appRotationTimer = null;
  let navigationId = 0;

  function rememberInstalledApp(installed) {
    try {
      if (installed) localStorage.setItem(installStateKey, "true");
      else localStorage.removeItem(installStateKey);
    } catch (error) {
      console.warn("MCH-BDTMS could not save the installation state.", error);
    }
  }

  function hasInstalledApp() {
    try {
      return localStorage.getItem(installStateKey) === "true";
    } catch (error) {
      console.warn("MCH-BDTMS could not read the installation state.", error);
      return false;
    }
  }

  function configureInstallExperience() {
    const installPanel = $("#install-app-panel");
    const installButton = $("#install-app-button");
    const installHelp = $("#install-app-help");
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
    const isIOS = /iphone|ipad|ipod/i.test(window.navigator.userAgent) ||
      (window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1);

    if ("serviceWorker" in navigator && window.isSecureContext) {
      navigator.serviceWorker.register("./service-worker.js").catch((error) => {
        console.error("MCH-BDTMS offline app shell could not be registered.", error);
      });
    }

    if (isStandalone) {
      rememberInstalledApp(true);
      installPanel.classList.add("hidden");
    } else if (!hasInstalledApp()) {
      installPanel.classList.remove("hidden");
    }
    if (isIOS) {
      installButton.textContent = "How to install on iPhone or iPad";
      installHelp.textContent = "Tap Share in Safari, then choose Add to Home Screen.";
      installHelp.classList.add("hidden");
    }

    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      deferredInstallPrompt = event;
      rememberInstalledApp(false);
      installPanel.classList.remove("hidden");
      installButton.textContent = "Install MCH-BDTMS";
    });
    window.addEventListener("appinstalled", () => {
      deferredInstallPrompt = null;
      rememberInstalledApp(true);
      installPanel.classList.add("hidden");
    });
    installButton.addEventListener("click", async () => {
      if (!deferredInstallPrompt) {
        if (!isIOS) installHelp.textContent = "Open your browser menu and choose Install app or Add to Home Screen.";
        installHelp.classList.remove("hidden");
        return;
      }
      try {
        await deferredInstallPrompt.prompt();
        const choice = await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        if (choice.outcome === "accepted") {
          rememberInstalledApp(true);
          installPanel.classList.add("hidden");
          return;
        }
        installHelp.textContent = "You can install MCH-BDTMS later from your browser menu.";
        installHelp.classList.remove("hidden");
      } catch (error) {
        console.error("The MCH-BDTMS install prompt could not be opened.", error);
        installHelp.textContent = "Open your browser menu and choose Install app or Add to Home Screen.";
        installHelp.classList.remove("hidden");
      }
    });
  }

  function showToast(message, isError) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.toggle("error", Boolean(isError));
    toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 3800);
  }

  function setConnectionStatus(status) {
    const labels = {
      checking: "Checking system...",
      active: "System active",
      "internet-down": "Internet is down",
      "system-down": "System is down"
    };
    connectionStatus = status;
    $$("[data-connection-status]").forEach((element) => {
      element.classList.remove("is-checking", "is-active", "is-internet-down", "is-system-down");
      element.classList.add("is-" + status);
      element.setAttribute("aria-label", labels[status]);
      const text = $(".connection-status-text", element);
      if (text) text.textContent = labels[status];
    });
  }

  function connectionErrorMessage() {
    return navigator.onLine ? "MCH-BDTMS is currently unavailable. Please try again shortly." :
      "Internet connection is down. Check your connection and try again.";
  }

  function initializeConnectionStatus() {
    setConnectionStatus(navigator.onLine ? "checking" : "internet-down");
    window.addEventListener("offline", () => setConnectionStatus("internet-down"));
    window.addEventListener("online", () => checkSystemAvailability(true));
    setInterval(() => {
      if (!navigator.onLine) return;
      checkSystemAvailability(false).then((available) => {
        if (!available || !state.user || document.visibilityState === "hidden") return;
        refreshLowStockNavigation().catch((error) => {
          console.error("Could not refresh the low-stock navigation badge.", error);
        });
      });
    }, 60000);
  }

  async function checkSystemAvailability(notifyRecovery) {
    if (!navigator.onLine) {
      setConnectionStatus("internet-down");
      return false;
    }
    if (connectionCheckPromise) {
      connectionRecoveryRequested = connectionRecoveryRequested || Boolean(notifyRecovery);
      return connectionCheckPromise;
    }
    const wasUnavailable = connectionStatus === "internet-down" || connectionStatus === "system-down";
    connectionRecoveryRequested = Boolean(notifyRecovery);
    if (wasUnavailable) invalidateResponseCache();
    if (wasUnavailable || notifyRecovery) setConnectionStatus("checking");
    connectionCheckPromise = (async () => {
      try {
        await request("bootstrap", {}, true);
        setConnectionStatus("active");
        if (wasUnavailable && state.token && state.user) await navigate(state.page);
        if (connectionRecoveryRequested && wasUnavailable && connectionStatus === "active") {
          showToast("Connection restored. System active.");
        }
        return true;
      } catch (error) {
        setConnectionStatus(navigator.onLine ? "system-down" : "internet-down");
        if (connectionRecoveryRequested) {
          showToast(navigator.onLine ? "System is still down. Please try again shortly." :
            "Internet is still down. Check your connection.", true);
        }
        return false;
      } finally {
        connectionCheckPromise = null;
        connectionRecoveryRequested = false;
      }
    })();
    return connectionCheckPromise;
  }

  function showSuccessDialog(title, message) {
    const dialog = $("#success-dialog");
    if (dialog.open) dialog.close();
    $("#success-title").textContent = title;
    $("#success-message").textContent = message;
    dialog.showModal();
  }

  function showErrorDialog(title, message) {
    const dialog = $("#error-dialog");
    if (dialog.open) dialog.close();
    $("#error-title").textContent = title;
    $("#error-message").textContent = message;
    dialog.showModal();
  }

  function showConfirmDialog(title, message, confirmLabel) {
    const dialog = $("#confirm-dialog");
    if (dialog.open) return Promise.resolve(false);
    $("#confirm-title").textContent = title;
    $("#confirm-message").textContent = message;
    const cancelButton = $("#confirm-cancel");
    const confirmButton = $("#confirm-accept");
    confirmButton.textContent = confirmLabel || "Confirm";
    return new Promise((resolve) => {
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
      dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        dialog.close("cancel");
      }, { once: true });
      cancelButton.onclick = () => dialog.close("cancel");
      confirmButton.onclick = () => dialog.close("confirm");
      dialog.showModal();
      cancelButton.focus();
    });
  }

  async function request(action, data, forceNetwork) {
    const cacheable = readActions.has(action);
    const key = state.token + "|" + action + (action === "previewPatientIssue" ? "|" + JSON.stringify(data || {}) : "");
    const generation = responseCacheGeneration;
    if (cacheable && !forceNetwork) {
      const cached = responseCache.get(key);
      if (cached && Date.now() - cached.createdAt < responseCacheTtl) return cached.value;
      if (pendingRequests.has(key)) return pendingRequests.get(key);
    }

    const operation = (async () => {
      if (!config.apiUrl || !/^https:\/\/script\.google\.com\/macros\/s\//.test(config.apiUrl)) {
        setConnectionStatus("system-down");
        throw new Error("Add your deployed Apps Script Web App URL to config.js first.");
      }
      let response;
      try {
        response = await fetch(config.apiUrl, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify(Object.assign({ action: action, token: state.token }, data || {}))
        });
      } catch (error) {
        const status = navigator.onLine ? "system-down" : "internet-down";
        setConnectionStatus(status);
        throw new Error(connectionErrorMessage());
      }
      if (!response.ok) {
        setConnectionStatus(navigator.onLine ? "system-down" : "internet-down");
        throw new Error(connectionErrorMessage());
      }
      let result;
      try {
        result = await response.json();
      } catch (error) {
        setConnectionStatus(navigator.onLine ? "system-down" : "internet-down");
        throw new Error(connectionErrorMessage());
      }
      if (!result) {
        setConnectionStatus(navigator.onLine ? "system-down" : "internet-down");
        throw new Error(connectionErrorMessage());
      }
      setConnectionStatus("active");
      if (!result.ok) throw new Error(result.error ? result.error : "The request could not be completed.");
      if (cacheable) {
        if (generation === responseCacheGeneration) responseCache.set(key, { value: result.data, createdAt: Date.now() });
      } else {
        invalidateResponseCache();
      }
      return result.data;
    })();

    if (!cacheable || forceNetwork) return operation;
    pendingRequests.set(key, operation);
    try {
      return await operation;
    } finally {
      if (pendingRequests.get(key) === operation) pendingRequests.delete(key);
    }
  }

  let responseCacheGeneration = 0;

  function invalidateResponseCache() {
    responseCacheGeneration += 1;
    responseCache.clear();
    pendingRequests.clear();
  }

  function rotateBackground(element, intervalMs) {
    const layers = Array.from({ length: 2 }, () => {
      const layer = document.createElement("div");
      layer.className = "background-slide";
      element.appendChild(layer);
      return layer;
    });
    const imageLoads = new Map();
    const loadImage = (path) => {
      if (imageLoads.has(path)) return imageLoads.get(path);
      const loaded = new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve(true);
        image.onerror = () => resolve(false);
        image.src = path;
      });
      imageLoads.set(path, loaded);
      return loaded;
    };
    let activeLayer = 0;
    let nextImage = 1;
    let updating = false;
    layers[activeLayer].style.backgroundImage = 'url("' + imagePaths[0] + '")';
    layers[activeLayer].classList.add("is-active");
    loadImage(imagePaths[0]);
    loadImage(imagePaths[nextImage]);
    const update = () => {
      if (updating) return;
      updating = true;
      const outgoing = layers[activeLayer];
      const incomingIndex = 1 - activeLayer;
      const incoming = layers[incomingIndex];
      const incomingPath = imagePaths[nextImage];
      loadImage(incomingPath).then(() => {
        incoming.classList.remove("is-active", "is-leaving");
        incoming.style.backgroundImage = 'url("' + incomingPath + '")';
        requestAnimationFrame(() => {
          outgoing.classList.remove("is-active");
          outgoing.classList.add("is-leaving");
          incoming.classList.add("is-active");
          activeLayer = incomingIndex;
          nextImage = (nextImage + 1) % imagePaths.length;
          updating = false;
          loadImage(imagePaths[nextImage]);
        });
      });
    };
    return setInterval(update, intervalMs);
  }

  function showAuthMessage(message, isError) {
    const box = $("#auth-message");
    box.textContent = message;
    box.classList.toggle("error", Boolean(isError));
    box.classList.remove("hidden");
  }

  function setAuthMode(mode) {
    $("#login-panel").classList.toggle("hidden", mode !== "login");
    $("#register-panel").classList.toggle("hidden", mode !== "register");
    $("#auth-message").classList.add("hidden");
  }

  function showApp(user) {
    if (authRotationTimer) {
      clearInterval(authRotationTimer);
      authRotationTimer = null;
    }
    if (!appRotationTimer) appRotationTimer = rotateBackground($("#app-background"), 12000);
    state.user = user;
    $("#auth").classList.add("hidden");
    $("#app-shell").classList.remove("hidden");
    $("#top-user-name").textContent = user.fullName;
    $("#top-user-role").textContent = user.role;
    $("#top-user-photo").src = user.photo || "assets/images/avatar-placeholder.svg";
    $$(".admin-only").forEach((item) => item.classList.toggle("hidden", user.role !== "Administrator"));
    navigate("home");
  }

  function showLogin() {
    if (appRotationTimer) {
      clearInterval(appRotationTimer);
      appRotationTimer = null;
    }
    if (!authRotationTimer) authRotationTimer = rotateBackground($(".auth-background"), 10000);
    localStorage.removeItem("mchToken");
    sessionStorage.removeItem("mchToken");
    state.token = "";
    state.user = null;
    $("#app-shell").classList.add("hidden");
    $("#auth").classList.remove("hidden");
  }

  function pageHeading(title, subtitle, actions) {
    return '<div class="page-heading"><div><h1>' + escapeHtml(title) + '</h1><p>' + escapeHtml(subtitle || "") +
      '</p></div><div class="heading-actions">' + (actions || "") + "</div></div>";
  }

  function statCard(label, value) {
    return '<div class="stat-card"><strong>' + escapeHtml(value) + '</strong><span>' + escapeHtml(label) + "</span></div>";
  }

  function patientStatCard(key, label, value) {
    return '<div class="stat-card"><strong data-patient-stat="' + key + '">' + escapeHtml(value) + '</strong><span>' + escapeHtml(label) + "</span></div>";
  }

  function emptyRow(columns, text) {
    return '<tr><td class="empty-state" colspan="' + columns + '">' + escapeHtml(text) + "</td></tr>";
  }

  function formatSex(value) {
    return value === "Female" ? "Female" : value === "Male" ? "Male" : "—";
  }

  function table(headers, rows, emptyMessage, tableClass, tableId, tbodyId) {
    return '<div class="table-wrap' + (tableClass ? " " + escapeHtml(tableClass) + "-wrap" : "") + '"><table' + (tableClass ? ' class="' + escapeHtml(tableClass) + '"' : "") +
      (tableId ? ' id="' + escapeHtml(tableId) + '"' : "") + '><thead><tr>' + headers.map((header) => "<th>" + escapeHtml(header) + "</th>").join("") +
      '</tr></thead><tbody' + (tbodyId ? ' id="' + escapeHtml(tbodyId) + '"' : "") + ">" +
      (rows.length ? rows.join("") : emptyRow(headers.length, emptyMessage || "No records found.")) +
      "</tbody></table></div>";
  }

  function recordActions(type, id, label) {
    return '<div class="table-actions"><button class="button button-secondary button-small" data-action="view" data-type="' + type +
      '" data-id="' + escapeHtml(id) + '">View</button><button class="button button-secondary button-small icon-action" data-action="edit" data-type="' +
      type + '" data-id="' + escapeHtml(id) + '" data-label="Edit ' + escapeHtml(label) + '" aria-label="Edit ' + escapeHtml(label) + '" title="Edit">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"></path></svg></button>' +
      '<button class="button button-danger button-small" data-action="delete" data-type="' + type +
      '" data-id="' + escapeHtml(id) + '" data-label="' + escapeHtml(label) + '">Delete</button></div>';
  }

  async function navigate(page) {
    if (page === "admin" && state.user.role !== "Administrator") return showToast("Administrator access is required.", true);
    const currentNavigationId = ++navigationId;
    state.page = page;
    $("#sidebar").classList.remove("is-open");
    $("#quick-add-patient").classList.toggle("hidden", page !== "patients");
    $$(".nav-item[data-page]").forEach((item) => item.classList.toggle("active", item.dataset.page === page));
    const titles = { home: "Home", donors: "Donors", patients: "Patients", "low-stock": "Low stock", reports: "Reports", recycle: "Recycle bin", admin: "Admin control panel", profile: "Profile" };
    $("#page-title").textContent = titles[page] || "Home";
    const content = $("#page-content");
    content.innerHTML = '<section class="panel loading-panel" role="status"><div class="loading-state"><span class="loading-spinner"></span>Loading your information…</div></section>';
    try {
      const renderers = { home: renderHome, donors: renderDonors, patients: renderPatients, "low-stock": renderLowStock, reports: renderReports, recycle: renderRecycle, admin: renderAdmin, profile: renderProfile };
      const html = await renderers[page]();
      if (currentNavigationId === navigationId) content.innerHTML = html;
    } catch (error) {
      if (currentNavigationId === navigationId) {
        content.innerHTML = '<section class="panel"><div class="notice error">' + escapeHtml(error.message) + '</div><button class="button button-secondary" data-action="refresh">Try again</button></section>';
      }
    }
  }

  async function getDashboard(forceNetwork) {
    const data = await request("dashboard", {}, Boolean(forceNetwork));
    updateLowStockNavigation(data.bloodGroups || []);
    return data;
  }

  function updateLowStockNavigation(bloodGroups) {
    const lowGroups = bloodGroups.filter((item) => item.lowStock === true ||
      (Number(item.received) > 0 && Number(item.remainingPercent) <= 30));
    const badge = $("#low-stock-nav-count");
    const navigationItem = $('[data-page="low-stock"]');
    if (!badge || !navigationItem) return;
    badge.textContent = lowGroups.length ? String(lowGroups.length) : "";
    badge.classList.toggle("hidden", lowGroups.length === 0);
    badge.setAttribute("aria-label", lowGroups.length + (lowGroups.length === 1 ? " group at low stock" : " groups at low stock"));
    navigationItem.setAttribute("aria-label", lowGroups.length
      ? "Low stock, " + lowGroups.length + (lowGroups.length === 1 ? " group needs attention" : " groups need attention")
      : "Low stock");
  }

  function refreshLowStockNavigation() {
    if (!state.user || !state.token) return Promise.resolve();
    return request("dashboard", {}, true).then((data) => {
      updateLowStockNavigation(data.bloodGroups || []);
    });
  }

  function refreshLowStockNavigationAfterMutation() {
    if (state.page === "home" || state.page === "low-stock") return;
    refreshLowStockNavigation().catch((error) => {
      console.error("Could not refresh the low-stock navigation badge.", error);
    });
  }

  async function renderHome() {
    const data = await getDashboard();
    const s = data.stats;
    const stats = [
      ["Total donors", s.totalDonors], ["Total patients", s.totalPatients], ["Male donors", s.maleDonors], ["Female donors", s.femaleDonors],
      ["Male patients", s.malePatients], ["Female patients", s.femalePatients], ["Blood units received", s.unitsReceived],
      ["Blood units issued", s.unitsIssued], ["Available blood units", s.availableUnits], ["Departments", s.departments],
      ["Donor amounts recorded", money(s.donorAmounts)]
    ];
    const groupMax = Math.max(1, ...data.bloodGroups.map((item) => Math.max(0, Number(item.units) || 0)));
    const bars = data.bloodGroups.map((item) => {
      const available = Math.max(0, Number(item.units) || 0);
      return '<div class="bar-row"><span>' + escapeHtml(item.group) +
        '</span><div class="bar-track"><div class="bar-fill" style="width:' + Math.round(available / groupMax * 100) +
        '%"></div></div><strong>' + available + "</strong></div>";
    }).join("");
    const availableGroups = data.bloodGroups.map((item) => ({
      group: item.group,
      received: Number(item.received || 0),
      issued: Number(item.issued || 0),
      available: Math.max(0, Number(item.units || 0)),
      remainingPercent: Number(item.remainingPercent == null ?
        percentage(Math.max(0, Number(item.units || 0)), Number(item.received || 0)) : item.remainingPercent)
    }));
    const totalAvailableByGroup = availableGroups.reduce((sum, item) => sum + item.available, 0);
    const groupRows = availableGroups.map((item, index) => "<tr><td>" + (index + 1) + "</td><td>" + escapeHtml(item.group) +
      "</td><td>" + item.received + "</td><td>" + item.issued + "</td><td><strong>" + item.available + "</strong></td><td>" +
      item.remainingPercent.toFixed(1) + "%</td><td>" + percentage(item.available, totalAvailableByGroup).toFixed(1) + "%</td></tr>");
    const departments = (data.departmentUsage || []).slice().sort((a, b) => Number(b.units) - Number(a.units));
    const highestDepartment = departments.find((item) => Number(item.units) > 0);
    const departmentRows = departments.map((item, index) => "<tr><td>" + (index + 1) + "</td><td>" +
      escapeHtml(item.department) + "</td><td>" + Number(item.units || 0) + "</td><td>" +
      percentage(Number(item.units || 0), s.unitsIssued).toFixed(1) + "%</td></tr>");
    const highestDepartmentHtml = highestDepartment ?
      '<div class="report-highlight"><strong>Highest receiving department:</strong> ' + escapeHtml(highestDepartment.department) +
      ' received ' + Number(highestDepartment.units) + ' of ' + Number(s.unitsIssued) + ' issued units (' +
      percentage(Number(highestDepartment.units), s.unitsIssued).toFixed(1) + '%).</div>' : "";
    const recentDonors = data.recentDonors.map((item) => "<tr><td>" + escapeHtml(item.name) + "</td><td>" +
      escapeHtml(item.bloodGroup) + "</td><td>" + escapeHtml(item.units) + "</td><td>" + escapeHtml(dateLabel(item.date)) + "</td></tr>");
    return pageHeading("Good day, " + state.user.fullName.split(" ")[0], "A quick overview of hospital blood services.", '<button class="button button-primary" data-action="add-donor">＋ Add donor</button>') +
      '<div class="stat-grid">' + stats.map((item) => statCard(item[0], item[1])).join("") + '</div><div class="overview-grid">' +
      '<section class="panel"><div class="panel-head"><div><h2>Blood group stock</h2><p>Donations received minus transfusions issued</p></div></div><div class="bar-list">' + bars +
      '</div></section><section class="panel"><div class="panel-head"><div><h2>Blood service summary</h2><p>All recorded activity</p></div></div><div class="summary-list">' +
      '<div class="summary-line"><span>Donations recorded</span><strong>' + s.totalDonors + '</strong></div><div class="summary-line"><span>Patient records</span><strong>' +
      s.totalPatients + '</strong></div><div class="summary-line"><span>Currently available</span><strong>' + s.availableUnits +
      ' units</strong></div><div class="summary-line"><span>Donor amounts</span><strong>' + money(s.donorAmounts) + '</strong></div></div></section></div>' +
      "<section class=\"panel\"><div class=\"panel-head\"><div><h2>Current blood bank stock by group</h2><p>Units available, percentage of that group's donations remaining, and share of total bank stock.</p></div></div>" +
      table(["S/N", "Blood group", "Units donated", "Units issued", "Units available", "% of donated stock remaining", "% of bank stock"], groupRows, "No blood groups are available.") + "</section>" +
      '<section class="panel"><div class="panel-head"><div><h2>Patient units issued by department</h2><p>Lifetime issue totals; select a reporting period for dated department comparisons.</p></div></div>' +
      highestDepartmentHtml + table(["Rank", "Department", "Units issued", "% of all units"], departmentRows, "No patient issues have been recorded.") + "</section>" +
      '<section class="panel"><div class="panel-head"><div><h2>Recent donations</h2><p>Most recently recorded donors</p></div><button class="button button-secondary button-small" data-page="donors">View all donors</button></div>' +
      table(["Donor", "Blood group", "Units", "Date"], recentDonors, "No donations have been recorded yet.") + "</section>";
  }

  async function renderLowStock() {
    const data = await getDashboard(true);
    const groups = (data.bloodGroups || []).map((item) => ({
      group: item.group,
      received: Number(item.received || 0),
      issued: Number(item.issued || 0),
      available: Math.max(0, Number(item.available == null ? item.units : item.available) || 0),
      remainingPercent: Number(item.remainingPercent || 0),
      lowStock: item.lowStock === true || (Number(item.received) > 0 && Number(item.remainingPercent) <= 30)
    }));
    const lowCount = groups.filter((item) => item.lowStock).length;
    const totalAvailable = groups.reduce((sum, item) => sum + item.available, 0);
    const rows = groups.map((item, index) => {
      const status = item.received === 0
        ? '<span class="status-pill">No donations</span>'
        : item.lowStock
          ? '<span class="status-pill deleted">LOW STOCK</span>'
          : '<span class="status-pill">In range</span>';
      return "<tr><td>" + (index + 1) + "</td><td><strong>" + escapeHtml(item.group) + "</strong></td><td>" +
        item.received + "</td><td>" + item.issued + "</td><td><strong>" + item.available + "</strong></td><td>" +
        item.remainingPercent.toFixed(1) + "%</td><td>" + status + "</td></tr>";
    });
    return pageHeading("Low stock", "Monitor remaining blood units by group. Low stock means 30% or less of donated units remain.",
      '<button class="button button-secondary" data-action="refresh">Refresh</button>') +
      '<section class="panel"><div class="stat-grid">' + statCard("Groups at low stock", lowCount) +
      statCard("Units currently available", totalAvailable) + statCard("Low-stock threshold", "30% or less") +
      '</div></section><section class="panel"><div class="panel-head"><div><h2>Blood-bank stock by group</h2>' +
      '<p>All blood groups are listed, including groups with no donations. The low-stock badge clears when a group rises above 30%.</p></div></div>' +
      table(["S/N", "Blood group", "Units donated", "Units issued", "Units available", "% of donated units remaining", "Status"],
        rows, "No blood groups are configured.") + "</section>";
  }

  async function renderDonors() {
    const [donors, amount] = await Promise.all([request("listDonors"), request("getSettings")]);
    state.cache.donors = donors;
    const male = donors.filter((item) => item.sex === "Male").length;
    const female = donors.filter((item) => item.sex === "Female").length;
    const units = donors.reduce((sum, item) => sum + Number(item.units || 0), 0);
    const total = donors.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const rows = donors.map((item, index) => '<tr><td>' + (index + 1) + "</td><td>" + escapeHtml(dateLabel(item.date)) + "</td><td>" +
      escapeHtml(item.time || "—") + "</td><td>" + escapeHtml(item.bloodGroup) + "</td><td>" + escapeHtml(item.name) + "</td><td>" +
      escapeHtml(formatSex(item.sex)) + "</td><td>" + escapeHtml(item.units) + "</td><td>" + escapeHtml(item.receiptNumber || "—") +
      "</td><td>" + money(item.amount) + "</td><td>" + escapeHtml(item.personnel || "—") + "</td><td>" +
      recordActions("donor", item.id, item.name) + "</td></tr>");
    return pageHeading("Donor records", "Record and review blood donations.", '<button class="button button-primary" data-action="add-donor">＋ Add donor</button><button class="button button-secondary" data-action="export" data-type="donors">Export CSV</button><button class="button button-secondary" data-action="print">Print</button>') +
      '<section class="panel"><div class="stat-grid">' + statCard("Male donors", male) + statCard("Female donors", female) + statCard("Blood units donated", units) + statCard("Recorded donor amounts", money(total)) +
      '</div><div class="toolbar"><label>Search donor<input data-filter="donors" placeholder="Donor name or receipt number"></label><label>Blood group<select data-filter="donor-group"><option value="">All blood groups</option>' +
      bloodOptions() + '</select></label></div></section><section class="panel">' +       table(["S/N", "Date", "Time", "Blood Group", "Name of Donor", "Sex", "Blood Units", "Receipt Number", "Amount (Le)", "Lab Personnel", "Actions"], rows, "No donor records found.", "donor-record-table", "donor-records") + "</section>";
  }

  async function renderPatients() {
    const [patients, departments] = await Promise.all([request("listPatients"), request("getDepartments")]);
    state.cache.patients = patients;
    state.cache.departments = departments;
    const deptOptions = departments.map((item) => '<option value="' + escapeHtml(item.name) + '">' + escapeHtml(item.name) + "</option>").join("");
    const rows = patients.map((item, index) => '<tr><td>' + (index + 1) + "</td><td>" + escapeHtml(dateLabel(item.date)) + "</td><td>" +
      escapeHtml(item.time || "—") + "</td><td>" + escapeHtml(item.bloodGroup) + "</td><td>" + escapeHtml(item.issuedBloodGroup || item.bloodGroup) +
      "</td><td>" + escapeHtml(item.name) + "</td><td>" +
      escapeHtml(item.age || "—") + "</td><td>" + escapeHtml(formatSex(item.sex)) + "</td><td>" + escapeHtml(item.department || "—") +
      "</td><td>" + escapeHtml(item.units) + "</td><td>" + escapeHtml(item.personnel || "—") + "</td><td>" +
      recordActions("patient", item.id, item.name) + "</td></tr>");
    return pageHeading("Patient records", "Track patient blood transfusions.", '<button class="button button-secondary" data-action="export" data-type="patients">Export CSV</button><button class="button button-secondary" data-action="print">Print</button>') +
      '<section class="panel"><div id="patient-summary" class="stat-grid">' + patientSummaryCards(patients) + '</div></section>' +
      '<section class="panel"><div class="toolbar"><label>Search patient<input data-filter="patients" placeholder="Patient name"></label><label>Blood group<select data-filter="patient-group"><option value="">All blood groups</option>' +
      bloodOptions() + '</select></label><label>Department<select data-filter="patient-department"><option value="">All departments</option>' + deptOptions +
      '</select></label></div></section><section class="panel"><div class="panel-head"><div><h2>Blood units by department</h2><p>All departments are shown when the department filter is set to All departments.</p></div></div>' +
      table(["Department", "Patients", "Blood Units Received", "Share of Total"], patientDepartmentRows(patients, departments), "No department data available.", "", "patient-department-summary", "patient-department-summary-body") +
      '</section><section class="panel">' +       table(["S/N", "Date", "Time", "Patient Blood Group", "Issued Blood Group", "Patient Name", "Age", "Sex", "Department", "Blood Units Issued", "Lab Personnel", "Actions"], rows, "No patient records found.", "patient-record-table", "patient-records") + "</section>";
  }

  function patientSummaryCards(patients) {
    const male = patients.filter((item) => item.sex === "Male").length;
    const female = patients.filter((item) => item.sex === "Female").length;
    const units = patients.reduce((sum, item) => sum + Number(item.units || 0), 0);
    return patientStatCard("total", "Total patients", patients.length) +
      patientStatCard("male", "Male patients", male) +
      patientStatCard("female", "Female patients", female) +
      patientStatCard("units", "Blood units received", units);
  }

  function patientDepartmentRows(patients, departments, denominatorPatients) {
    return reportDepartmentUsage(departments, patients, denominatorPatients).map((item) => "<tr><td>" + escapeHtml(item.department) + "</td><td>" +
      patients.filter((patient) => String(patient.department || "Unassigned") === item.department).length + "</td><td>" +
      item.units + "</td><td>" + item.percent.toFixed(1) + "%</td></tr>");
  }

  function updatePatientSummary(patients, departmentBaseline) {
    const summary = $("#patient-summary");
    const departmentSelect = $('[data-filter="patient-department"]');
    const body = $("#patient-department-summary-body");
    if (!summary || !departmentSelect || !body) return;
    const cards = patientSummaryCards(patients);
    const holder = document.createElement("div");
    holder.innerHTML = cards;
    ["total", "male", "female", "units"].forEach((key) => {
      const current = $('[data-patient-stat="' + key + '"]', summary);
      const next = $('[data-patient-stat="' + key + '"]', holder);
      if (current && next) current.textContent = next.textContent;
    });
    const selected = departmentSelect.value;
    const departments = selected ? (state.cache.departments || []).filter((item) => item.name === selected) : (state.cache.departments || []);
    const baseline = departmentBaseline || patients;
    const rows = patientDepartmentRows(patients, departments, baseline);
    body.innerHTML = rows.length ? rows.join("") : emptyRow(4, "No department data available.");
  }

  const reportMonths = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  async function renderReports() {
    const [donors, patients, departments] = await Promise.all([
      request("listDonors"), request("listPatients"), request("getDepartments")
    ]);
    const reportData = { donors: donors, patients: patients, departments: departments };
    state.cache.reportData = reportData;
    const reportDepartments = Array.from(new Set(departments.map((item) => String(item.name)).concat(
      patients.map((item) => String(item.department || "Unassigned"))
    ))).sort((a, b) => a.localeCompare(b));
    const now = new Date();
    const years = Array.from({ length: 10 }, (_, index) => 2026 + index);
    const year = Math.min(2035, Math.max(2026, now.getFullYear()));
    const month = now.getMonth() + 1;
    const quarter = Math.floor(now.getMonth() / 3) + 1;
    const halfYear = now.getMonth() < 6 ? 1 : 2;
    const currentPeriodStart = now.getFullYear() === year ? reportIsoDate(year, month, 1) : reportIsoDate(year, 1, 1);
    const currentPeriodEnd = now.getFullYear() === year ? today() : reportIsoDate(year, 12, 31);
    const filters = {
      period: "Monthly", monthFrom: String(month), monthTo: String(month),
      yearFrom: String(year), yearTo: String(year),
      quarterFrom: String(quarter), quarterTo: String(quarter),
      halfYearFrom: String(halfYear), halfYearTo: String(halfYear),
      fromDate: currentPeriodStart, toDate: currentPeriodEnd, department: ""
    };
    const yearOptions = years.map((value) => '<option value="' + value + '"' + (value === year ? " selected" : "") + ">" + value + "</option>").join("");
    const monthOptions = reportMonths.map((value, index) => '<option value="' + (index + 1) + '"' +
      (index + 1 === month ? " selected" : "") + ">" + value + "</option>").join("");
    const quarterOptions = ["Q1 (Jan-Mar)", "Q2 (Apr-Jun)", "Q3 (Jul-Sep)", "Q4 (Oct-Dec)"].map((value, index) =>
      '<option value="' + (index + 1) + '"' + (index + 1 === quarter ? " selected" : "") + ">" + value + "</option>").join("");
    const halfYearOptions = ['<option value="1"' + (halfYear === 1 ? " selected" : "") + ">First half (Jan-Jun)</option>",
      '<option value="2"' + (halfYear === 2 ? " selected" : "") + ">Second half (Jul-Dec)</option>"].join("");
    const departmentOptions = '<option value="">All departments</option>' + reportDepartments.map((name) =>
      '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + "</option>").join("");
    const tabs = [
      ["donors", "Donor Reports"], ["patients", "Patient Reports"], ["departments", "Department Reports"],
      ["financial", "Financial Reports"], ["statistics", "Statistical Dashboard"]
    ];
    const tabsHtml = tabs.map((item) => '<button type="button" class="tab-button' + (state.reportTab === item[0] ? " active" : "") +
      '" data-report-tab="' + item[0] + '" aria-pressed="' + (state.reportTab === item[0]) + '">' + item[1] + "</button>").join("");
    const initialRange = reportDateRange(filters);
    return pageHeading("Reports", "Choose a single month, quarter, or year, or keep using date ranges. Print reports with charts and written summaries.", '<button class="button button-secondary" data-action="print">Print report</button>') +
      '<div class="report-tabs">' + tabsHtml + '</div><form id="report-filter-form" class="panel report-filter-panel form-watermark"><div class="toolbar report-toolbar">' +
      '<label>Period<select name="period" id="report-period"><option>Daily</option><option>Single month</option><option selected>Monthly</option><option>Single quarter</option><option>Quarterly</option><option>Half-Yearly</option><option>Single year</option><option>Annual / Yearly</option><option>Custom range</option></select></label>' +
      '<label class="report-period-control" data-report-control="monthFrom"><span data-report-label="monthFrom">Month from</span><select name="monthFrom">' + monthOptions + '</select></label>' +
      '<label class="report-period-control" data-report-control="yearFrom"><span data-report-label="yearFrom">Year from</span><select name="yearFrom">' + yearOptions + '</select></label>' +
      '<label class="report-period-control" data-report-control="monthTo"><span>Month to</span><select name="monthTo">' + monthOptions + '</select></label>' +
      '<label class="report-period-control" data-report-control="yearTo"><span>Year to</span><select name="yearTo">' + yearOptions + '</select></label>' +
      '<label class="report-period-control hidden" data-report-control="quarterFrom"><span data-report-label="quarterFrom">Quarter from</span><select name="quarterFrom">' + quarterOptions + '</select></label>' +
      '<label class="report-period-control hidden" data-report-control="quarterTo"><span>Quarter to</span><select name="quarterTo">' + quarterOptions + '</select></label>' +
      '<label class="report-period-control hidden" data-report-control="halfYearFrom">Half-year from<select name="halfYearFrom">' + halfYearOptions + '</select></label>' +
      '<label class="report-period-control hidden" data-report-control="halfYearTo">Half-year to<select name="halfYearTo">' + halfYearOptions + '</select></label>' +
      '<label class="report-period-control hidden" data-report-control="fromDate">Date from<input name="fromDate" type="date" min="2026-01-01" max="2035-12-31" value="' + filters.fromDate + '"></label>' +
      '<label class="report-period-control hidden" data-report-control="toDate">Date to<input name="toDate" type="date" min="2026-01-01" max="2035-12-31" value="' + filters.toDate + '"></label>' +
      '<label>Department<select name="department">' + departmentOptions + '</select></label>' +
      '<button class="button button-primary" type="submit">Generate</button></div></form>' +
      '<p class="report-filter-help">Department selection applies to patient, department, and statistical reports. Choose All departments to include every department.</p>' +
      '<div id="report-results" aria-live="polite">' + renderReportResults(state.reportTab, reportData, initialRange) + "</div>";
  }

  function reportDateRange(filters) {
    let start;
    let end;
    if (filters.period === "Custom range" || filters.period === "Daily") {
      start = String(filters.fromDate || "");
      end = String(filters.toDate || "");
      if (!isValidReportDate(start) || !isValidReportDate(end) || start > end) {
        throw new Error("Choose valid start and end dates.");
      }
    } else {
      const yearFrom = reportYear(filters.yearFrom);
      if (filters.period === "Single month") {
        const month = reportMonth(filters.monthFrom);
        start = reportIsoDate(yearFrom, month, 1);
        end = reportIsoDate(yearFrom, month, new Date(yearFrom, month, 0).getDate());
      } else if (filters.period === "Monthly") {
        const yearTo = reportYear(filters.yearTo);
        if (yearFrom > yearTo) throw new Error("The start year must not be later than the end year.");
        const monthFrom = reportMonth(filters.monthFrom);
        const monthTo = reportMonth(filters.monthTo);
        start = reportIsoDate(yearFrom, monthFrom, 1);
        end = reportIsoDate(yearTo, monthTo, new Date(yearTo, monthTo, 0).getDate());
      } else if (filters.period === "Single quarter") {
        const quarter = reportSelection(filters.quarterFrom, 1, 4, "quarter");
        const startMonth = (quarter - 1) * 3 + 1;
        const endMonth = quarter * 3;
        start = reportIsoDate(yearFrom, startMonth, 1);
        end = reportIsoDate(yearFrom, endMonth, new Date(yearFrom, endMonth, 0).getDate());
      } else if (filters.period === "Quarterly") {
        const yearTo = reportYear(filters.yearTo);
        if (yearFrom > yearTo) throw new Error("The start year must not be later than the end year.");
        const quarterFrom = reportSelection(filters.quarterFrom, 1, 4, "start quarter");
        const quarterTo = reportSelection(filters.quarterTo, 1, 4, "end quarter");
        const startMonth = (quarterFrom - 1) * 3 + 1;
        const endMonth = quarterTo * 3;
        start = reportIsoDate(yearFrom, startMonth, 1);
        end = reportIsoDate(yearTo, endMonth, new Date(yearTo, endMonth, 0).getDate());
      } else if (filters.period === "Half-Yearly") {
        const yearTo = reportYear(filters.yearTo);
        if (yearFrom > yearTo) throw new Error("The start year must not be later than the end year.");
        const halfYearFrom = reportSelection(filters.halfYearFrom, 1, 2, "start half-year");
        const halfYearTo = reportSelection(filters.halfYearTo, 1, 2, "end half-year");
        const startMonth = halfYearFrom === 1 ? 1 : 7;
        const endMonth = halfYearTo === 1 ? 6 : 12;
        start = reportIsoDate(yearFrom, startMonth, 1);
        end = reportIsoDate(yearTo, endMonth, new Date(yearTo, endMonth, 0).getDate());
      } else if (filters.period === "Single year") {
        start = reportIsoDate(yearFrom, 1, 1);
        end = reportIsoDate(yearFrom, 12, 31);
      } else {
        const yearTo = reportYear(filters.yearTo);
        if (yearFrom > yearTo) throw new Error("The start year must not be later than the end year.");
        start = reportIsoDate(yearFrom, 1, 1);
        end = reportIsoDate(yearTo, 12, 31);
      }
      if (start > end) throw new Error("The report start must be on or before its end.");
    }
    let label = dateLabel(start) + (start === end ? "" : " - " + dateLabel(end));
    const startParts = start.split("-").map(Number);
    if (filters.period === "Single month") {
      label = reportMonths[startParts[1] - 1] + " " + startParts[0];
    } else if (filters.period === "Single quarter") {
      const quarter = Math.ceil(startParts[1] / 3);
      const firstMonth = (quarter - 1) * 3;
      label = "Q" + quarter + " (" + reportMonths[firstMonth].slice(0, 3) + "-" +
        reportMonths[firstMonth + 2].slice(0, 3) + ") " + startParts[0];
    } else if (filters.period === "Single year") {
      label = String(startParts[0]);
    }
    return { start: start, end: end, period: filters.period, label: label, department: String(filters.department || "") };
  }

  function reportYear(value) {
    const year = Number(value);
    if (!Number.isInteger(year) || year < 2026 || year > 2035) throw new Error("Choose a year from 2026 to 2035.");
    return year;
  }

  function reportMonth(value) {
    return reportSelection(value, 1, 12, "month");
  }

  function reportSelection(value, minimum, maximum, label) {
    const selection = Number(value);
    if (!Number.isInteger(selection) || selection < minimum || selection > maximum) {
      throw new Error("Choose a valid " + label + ".");
    }
    return selection;
  }

  function reportIsoDate(year, month, day) {
    return String(year).padStart(4, "0") + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
  }

  function isValidReportDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    return year >= 2026 && year <= 2035 && date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  }

  function recordsInRange(records, range) {
    return records.filter((item) => {
      const date = String(item.date || "").slice(0, 10);
      return date >= range.start && date <= range.end;
    });
  }

  function percentage(value, total) {
    return total ? value / total * 100 : 0;
  }

  function histogram(title, description, items, formatter) {
    const max = Math.max(1, ...items.map((item) => Number(item.value) || 0));
    const bars = items.map((item) => {
      const value = Number(item.value) || 0;
      const height = value > 0 ? Math.max(2, value / max * 100) : 0;
      return '<div class="histogram-item" title="' + escapeHtml(item.label + ": " + (item.detail || value)) + '">' +
        '<span class="histogram-value">' + escapeHtml(formatter ? formatter(value) : value.toLocaleString("en-US")) + "</span>" +
        '<div class="histogram-track"><div class="histogram-bar" style="--bar-height:' + height + '%"></div></div>' +
        '<span class="histogram-label">' + escapeHtml(item.label) + "</span>" +
        (item.detail ? '<small class="histogram-detail">' + escapeHtml(item.detail) + "</small>" : "") + "</div>";
    }).join("");
    return '<section class="panel chart-panel"><div class="panel-head"><div><h2>' + escapeHtml(title) + '</h2><p>' + escapeHtml(description) +
      '</p></div></div>' + (items.length ? '<div class="histogram">' + bars + "</div>" : '<div class="empty-state">No data for this period.</div>') + "</section>";
  }

  const reportChartColors = ["#a31424", "#152b3e", "#d7a64b", "#4d8c75", "#ba6c45", "#78879a", "#7d5da8", "#3b7c9b"];

  function chartPanel(title, description, content) {
    return '<section class="panel chart-panel"><div class="panel-head"><div><h2>' + escapeHtml(title) + '</h2><p>' +
      escapeHtml(description) + "</p></div></div>" + content + "</section>";
  }

  function barChart(title, description, items, formatter) {
    const data = items;
    if (!data.some((item) => Number(item.value) > 0)) {
      return chartPanel(title, description, '<div class="empty-state">No data for this period.</div>');
    }
    const left = 46;
    const right = 12;
    const top = 14;
    const base = 190;
    const stepWidth = Math.max(32, Math.min(56, 394 / Math.max(data.length, 1)));
    const width = Math.max(440, left + right + stepWidth * data.length);
    const plotWidth = width - left - right;
    const plotHeight = base - top;
    const max = Math.max(1, ...data.map((item) => Number(item.value) || 0));
    const step = plotWidth / data.length;
    const labelStep = Math.max(1, Math.ceil(data.length / 12));
    const bars = data.map((item, index) => {
      const value = Number(item.value) || 0;
      const height = value / max * plotHeight;
      const barWidth = Math.min(34, step * .58);
      const x = left + index * step + (step - barWidth) / 2;
      const y = base - height;
      const label = String(item.label || "");
      return '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barWidth.toFixed(1) + '" height="' +
        Math.max(height, 0).toFixed(1) + '" rx="4" fill="' + (item.color || reportChartColors[index % reportChartColors.length]) +
        '"><title>' + escapeHtml(label + ": " + (formatter ? formatter(value) : value.toLocaleString("en-US"))) +
        "</title></rect>" + (index % labelStep === 0 || index === data.length - 1 ?
          '<text class="chart-axis-label" x="' + (left + index * step + step / 2).toFixed(1) +
          '" y="211" text-anchor="middle">' + escapeHtml(label.length > 12 ? label.slice(0, 11) + "…" : label) + "</text>" : "");
    }).join("");
    const grid = [0, 1, 2, 3, 4].map((index) => {
      const y = base - index * plotHeight / 4;
      const value = max * index / 4;
      return '<line x1="' + left + '" y1="' + y.toFixed(1) + '" x2="' + (width - right) +
        '" y2="' + y.toFixed(1) + '" class="chart-gridline"></line><text class="chart-tick" x="' + (left - 7) +
        '" y="' + (y + 3).toFixed(1) + '" text-anchor="end">' + escapeHtml(formatter ? formatter(value) : Math.round(value).toLocaleString("en-US")) + "</text>";
    }).join("");
    return chartPanel(title, description, '<div class="svg-chart-scroll"><svg class="report-svg" style="min-width:' + width +
      'px" viewBox="0 0 ' + width + ' 230" role="img" aria-label="' +
      escapeHtml(title) + '">' + grid + bars + "</svg></div>");
  }

  function pieChart(title, description, items, formatter) {
    const data = items.filter((item) => Number(item.value) > 0);
    const total = data.reduce((sum, item) => sum + Number(item.value), 0);
    if (!total) return chartPanel(title, description, '<div class="empty-state">No data for this period.</div>');
    const center = 120;
    const radius = 108;
    let angle = -Math.PI / 2;
    const slices = data.map((item, index) => {
      const portion = Number(item.value) / total;
      const nextAngle = angle + portion * Math.PI * 2;
      const color = item.color || reportChartColors[index % reportChartColors.length];
      let shape;
      if (portion > .9999) {
        shape = '<circle cx="' + center + '" cy="' + center + '" r="' + radius + '" fill="' + color + '"></circle>';
      } else {
        const x1 = center + radius * Math.cos(angle);
        const y1 = center + radius * Math.sin(angle);
        const x2 = center + radius * Math.cos(nextAngle);
        const y2 = center + radius * Math.sin(nextAngle);
        const largeArc = portion > .5 ? 1 : 0;
        shape = '<path d="M ' + center + " " + center + " L " + x1.toFixed(2) + " " + y1.toFixed(2) +
          " A " + radius + " " + radius + " 0 " + largeArc + " 1 " + x2.toFixed(2) + " " + y2.toFixed(2) +
          ' Z" fill="' + color + '"></path>';
      }
      angle = nextAngle;
      return "<g><title>" + escapeHtml(item.label + ": " + (formatter ? formatter(Number(item.value)) :
        Number(item.value).toLocaleString("en-US")) + " (" + percentage(Number(item.value), total).toFixed(1) + "%)") + "</title>" + shape + "</g>";
    }).join("");
    const legend = data.map((item, index) => '<li><span class="chart-legend-dot" style="--legend-color:' +
      (item.color || reportChartColors[index % reportChartColors.length]) + '"></span><span>' + escapeHtml(item.label) +
      '</span><strong>' + escapeHtml(formatter ? formatter(Number(item.value)) : Number(item.value).toLocaleString("en-US")) + "</strong></li>").join("");
    return chartPanel(title, description, '<div class="pie-chart-layout"><svg class="pie-svg" viewBox="0 0 240 240" role="img" aria-label="' +
      escapeHtml(title) + '">' + slices + '<circle cx="120" cy="120" r="48" fill="#fff"></circle><text class="pie-total" x="120" y="116" text-anchor="middle">' +
      escapeHtml(formatter ? formatter(total) : total.toLocaleString("en-US")) + '</text><text class="pie-total-caption" x="120" y="137" text-anchor="middle">TOTAL</text></svg><ul class="chart-legend">' +
      legend + "</ul></div>");
  }

  function lineChart(title, description, labels, series, formatter) {
    const values = series.reduce((all, item) => all.concat(item.values), []);
    if (!values.some((value) => Number(value) > 0)) {
      return chartPanel(title, description, '<div class="empty-state">No data for this period.</div>');
    }
    const left = 48;
    const right = 12;
    const top = 18;
    const base = 190;
    const width = Math.max(440, left + right + Math.max(labels.length, 1) * 38);
    const plotWidth = width - left - right;
    const plotHeight = base - top;
    const max = Math.max(1, ...values.map((value) => Number(value) || 0));
    const xAt = (index) => left + (labels.length < 2 ? plotWidth / 2 : index * plotWidth / (labels.length - 1));
    const grid = [0, 1, 2, 3, 4].map((index) => {
      const y = base - index * plotHeight / 4;
      const value = max * index / 4;
      return '<line x1="' + left + '" y1="' + y.toFixed(1) + '" x2="' + (width - right) +
        '" y2="' + y.toFixed(1) + '" class="chart-gridline"></line><text class="chart-tick" x="' + (left - 7) +
        '" y="' + (y + 3).toFixed(1) + '" text-anchor="end">' + escapeHtml(formatter ? formatter(value) : Math.round(value).toLocaleString("en-US")) + "</text>";
    }).join("");
    const paths = series.map((item) => {
      const points = item.values.map((value, index) =>
        xAt(index).toFixed(1) + "," + (base - (Number(value) || 0) / max * plotHeight).toFixed(1)).join(" ");
      const markers = item.values.map((value, index) => {
        const x = xAt(index);
        const y = base - (Number(value) || 0) / max * plotHeight;
        return '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="3.5" fill="' + item.color +
          '"><title>' + escapeHtml(item.name + " - " + labels[index] + ": " +
            (formatter ? formatter(Number(value) || 0) : (Number(value) || 0).toLocaleString("en-US"))) + "</title></circle>";
      }).join("");
      return '<polyline points="' + points + '" fill="none" stroke="' + item.color +
        '" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>' + markers;
    }).join("");
    const labelStep = Math.max(1, Math.ceil(labels.length / 7));
    const xLabels = labels.map((label, index) => index % labelStep === 0 || index === labels.length - 1 ?
      '<text class="chart-axis-label" x="' + xAt(index).toFixed(1) + '" y="211" text-anchor="middle">' +
      escapeHtml(label.length > 12 ? label.slice(0, 11) + "…" : label) + "</text>" : "").join("");
    const legend = series.map((item) => '<span><i style="--legend-color:' + item.color + '"></i>' + escapeHtml(item.name) + "</span>").join("");
    return chartPanel(title, description, '<div class="svg-chart-scroll"><svg class="report-svg" style="min-width:' + width +
      'px" viewBox="0 0 ' + width + ' 230" role="img" aria-label="' +
      escapeHtml(title) + '">' + grid + paths + xLabels + "</svg></div><div class=\"line-legend\">" + legend + "</div>");
  }

  function reportDepartmentUsage(departments, patients, denominatorPatients) {
    const totals = new Map(departments.map((item) => [String(item.name), 0]));
    patients.forEach((item) => {
      const department = String(item.department || "Unassigned");
      totals.set(department, (totals.get(department) || 0) + Number(item.units || 0));
    });
    const totalUnits = (denominatorPatients || patients).reduce((sum, item) => sum + Number(item.units || 0), 0);
    return Array.from(totals.entries()).map((entry) => ({
      department: entry[0], units: entry[1], percent: percentage(entry[1], totalUnits)
    })).sort((a, b) => b.units - a.units || a.department.localeCompare(b.department));
  }

  function reportDepartmentBreakdown(department, patients) {
    const records = patients.filter((item) => String(item.department || "Unassigned") === department.department);
    const maleUnits = records.filter((item) => item.sex === "Male").reduce((sum, item) => sum + Number(item.units || 0), 0);
    const femaleUnits = records.filter((item) => item.sex === "Female").reduce((sum, item) => sum + Number(item.units || 0), 0);
    const bloodGroups = reportBloodGroups([], records).map((item) => ({
      group: item.group,
      units: item.issued,
      percent: percentage(item.issued, department.units)
    }));
    return {
      department: department.department,
      patientRecords: records.length,
      units: department.units,
      percent: department.percent,
      maleUnits: maleUnits,
      malePercent: percentage(maleUnits, department.units),
      femaleUnits: femaleUnits,
      femalePercent: percentage(femaleUnits, department.units),
      bloodGroups: bloodGroups
    };
  }

  function reportDepartmentGroupRows(departmentBreakdown) {
    return departmentBreakdown.reduce((rows, item) => rows.concat(item.bloodGroups
      .filter((group) => group.units > 0)
      .map((group) => "<tr><td>" + escapeHtml(item.department) + "</td><td>" + group.group + "</td><td>" +
        group.units + "</td><td>" + group.percent.toFixed(1) + "%</td></tr>")), []);
  }

  function renderDepartmentBloodGroupTable(departmentBreakdown) {
    return '<section class="panel"><div class="panel-head"><div><h2>Blood units issued by department and group</h2>' +
      "<p>Each row shows the number of units issued to that department. The percentage is of that department's total.</p></div></div>" +
      table(["Department", "Blood group", "Units issued", "% of department units"], reportDepartmentGroupRows(departmentBreakdown),
        "No blood units were issued by blood group in this period.") + "</section>";
  }

  function renderBloodGroupIssueTable(patients) {
    const groups = reportBloodGroups([], patients);
    const total = patients.reduce((sum, item) => sum + Number(item.units || 0), 0);
    const rows = groups.map((item) => "<tr><td>" + item.group + "</td><td>" + item.issued + "</td><td>" +
      percentage(item.issued, total).toFixed(1) + "%</td></tr>");
    return '<section class="panel"><div class="panel-head"><div><h2>Patient units issued by blood group</h2>' +
      '<p>Percentages are calculated from all patient units in the selected report scope.</p></div></div>' +
      table(["Blood group", "Units issued", "% of patient units"], rows, "No patient issues in this period.") + "</section>";
  }

  function renderDepartmentDetailCharts(departments, patients) {
    const sexItems = departments.reduce((items, item) => items.concat([
      { label: item.department + " male", value: item.maleUnits, color: reportChartColors[0] },
      { label: item.department + " female", value: item.femaleUnits, color: reportChartColors[2] }
    ]), []);
    const groupItems = reportBloodGroups([], patients).map((item) => ({
      label: item.group, value: item.issued
    }));
    return '<div class="report-visual-grid">' +
      barChart("Units issued by sex and department", "Compare male and female units within each department.", sexItems) +
      pieChart("Blood-group share", "Share of all units issued to the selected department(s).", groupItems) +
      "</div>";
  }

  function renderReportResults(tab, source, range) {
    const donors = recordsInRange(source.donors, range);
    const allPatients = recordsInRange(source.patients, range);
    const departmentFilterApplies = ["patients", "departments", "statistics"].includes(tab);
    const patients = departmentFilterApplies && range.department ?
      allPatients.filter((item) => String(item.department || "Unassigned") === range.department) : allPatients;
    const donorUnits = donors.reduce((sum, item) => sum + Number(item.units || 0), 0);
    const patientUnits = patients.reduce((sum, item) => sum + Number(item.units || 0), 0);
    const allPatientUnits = allPatients.reduce((sum, item) => sum + Number(item.units || 0), 0);
    const donorAmounts = donors.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const maleDonors = donors.filter((item) => item.sex === "Male");
    const femaleDonors = donors.filter((item) => item.sex === "Female");
    const malePatients = patients.filter((item) => item.sex === "Male");
    const femalePatients = patients.filter((item) => item.sex === "Female");
    const departmentUsage = reportDepartmentUsage(source.departments, patients, allPatients)
      .filter((item) => !departmentFilterApplies || !range.department || item.department === range.department);
    if (departmentFilterApplies && range.department && !departmentUsage.some((item) => item.department === range.department)) {
      departmentUsage.push({ department: range.department, units: 0, percent: 0 });
    }
    const departmentBreakdown = departmentUsage.map((item) => reportDepartmentBreakdown(item, patients));
    const monthlyTotals = reportMonthlyTotals(donors, patients, range);
    const chartSet = renderReportChartSuite(tab, donors, patients, departmentUsage, monthlyTotals) +
      (tab === "departments" ? renderDepartmentDetailCharts(departmentBreakdown, patients) : "");
    const reportIntro = reportPrintHeader(tab, range) +
      reportWrittenSummary(tab, range, donors, patients, departmentUsage, donorUnits, patientUnits, donorAmounts, allPatientUnits);
    const periodHeading = '<section class="report-period-note">Report period: <strong>' + escapeHtml(range.label) + "</strong></section>";

    if (tab === "donors") {
      const rows = donors.map((item, index) => "<tr><td>" + (index + 1) + "</td><td>" + escapeHtml(dateLabel(item.date)) + "</td><td>" +
        escapeHtml(item.time || "—") + "</td><td>" + escapeHtml(item.bloodGroup) + "</td><td>" + escapeHtml(item.name) + "</td><td>" +
        escapeHtml(item.sex) + "</td><td>" + escapeHtml(item.units) + "</td><td>" + escapeHtml(item.receiptNumber || "—") + "</td><td>" +
        money(item.amount) + "</td><td>" + escapeHtml(item.personnel || "—") + "</td></tr>");
      return reportIntro + periodHeading + '<div class="stat-grid">' + statCard("Donation records", donors.length) + statCard("Blood units donated", donorUnits) +
        statCard("Male donors", maleDonors.length) + statCard("Female donors", femaleDonors.length) + '</div>' + chartSet +
        '<section class="panel">' + table(["S/N", "Date", "Time", "Blood Group", "Name of Donor", "Sex", "Blood Units", "Receipt Number", "Amount (Le)", "Lab Personnel"], rows, "No donor records in this period.") + "</section>";
    }

    if (tab === "patients") {
      const highestDepartment = departmentUsage.find((item) => item.units > 0);
      const rows = patients.map((item, index) => "<tr><td>" + (index + 1) + "</td><td>" + escapeHtml(dateLabel(item.date)) + "</td><td>" +
        escapeHtml(item.time || "—") + "</td><td>" + escapeHtml(item.bloodGroup) + "</td><td>" +
        escapeHtml(item.issuedBloodGroup || item.bloodGroup) + "</td><td>" + escapeHtml(item.name) + "</td><td>" +
        escapeHtml(item.age || "—") + "</td><td>" + escapeHtml(item.sex) + "</td><td>" + escapeHtml(item.department || "—") + "</td><td>" +
        escapeHtml(item.units) + "</td><td>" + escapeHtml(item.personnel || "—") + "</td></tr>");
      const highest = highestDepartment ? '<div class="report-highlight"><strong>Highest receiving department:</strong> ' +
        escapeHtml(highestDepartment.department) + " received " + highestDepartment.units + " unit(s) (" +
        highestDepartment.percent.toFixed(1) + "% of units issued)." + "</div>" : "";
      return reportIntro + periodHeading + '<div class="stat-grid">' + statCard("Patient records", patients.length) + statCard("Blood units issued", patientUnits) +
        statCard("Male patients", malePatients.length) + statCard("Female patients", femalePatients.length) + '</div>' + highest + chartSet +
        renderDepartmentBloodGroupTable(departmentBreakdown) + renderBloodGroupIssueTable(patients) +
        '<section class="panel">' + table(["S/N", "Date", "Time", "Patient Blood Group", "Issued Blood Group", "Patient Name", "Age", "Sex", "Department", "Blood Units Issued", "Lab Personnel"], rows, "No patient records in this period.") + "</section>";
    }

    if (tab === "departments") {
      const highest = departmentUsage.find((item) => item.units > 0);
      const departmentRows = departmentBreakdown.map((item, index) => "<tr><td>" + (index + 1) + "</td><td>" +
        escapeHtml(item.department) + "</td><td>" + item.patientRecords + "</td><td>" + item.units + "</td><td>" +
        item.percent.toFixed(1) + "%</td><td>" + item.maleUnits + " (" + item.malePercent.toFixed(1) + "%)</td><td>" +
        item.femaleUnits + " (" + item.femalePercent.toFixed(1) + "%)</td></tr>");
      const summary = highest ? '<div class="report-highlight"><strong>Highest receiving department:</strong> ' + escapeHtml(highest.department) +
        " received " + highest.units + " unit(s) (" + highest.percent.toFixed(1) + "% of units issued).</div>" :
        '<div class="report-highlight">No blood units were issued in this period.</div>';
      return reportIntro + periodHeading + summary + chartSet +
        '<section class="panel"><div class="panel-head"><div><h2>Units received by department and sex</h2><p>Sex percentages show the share of department units issued to male and female patients.</p></div></div>' +
        table(["S/N", "Department", "Patient records", "Units received", "% of all units", "Male units (% dept.)", "Female units (% dept.)"],
          departmentRows, "No department data in this period.") + "</section>" +
        renderDepartmentBloodGroupTable(departmentBreakdown) +
        '<p class="subtle">Department totals show units issued to patients, not separately held stock. Current bank stock is tracked centrally by blood group.</p>';
    }

    if (tab === "financial") {
      const months = monthlyTotals.filter((item) => item.amount > 0);
      const rows = months.map((item, index) => "<tr><td>" + (index + 1) + "</td><td>" + escapeHtml(item.label) +
        "</td><td>" + money(item.amount) + "</td></tr>");
      return reportIntro + periodHeading + '<div class="stat-grid">' + statCard("Recorded donor amounts", money(donorAmounts)) +
        statCard("Donation records", donors.length) + statCard("Donor units", donorUnits) + '</div>' + chartSet +
        '<section class="panel">' + table(["S/N", "Period", "Recorded Amount (Le)"], rows, "No donor amounts in this period.") + "</section>" +
        '<p class="subtle">Amounts shown are recorded amounts, not confirmation that payment was received.</p>';
    }

    const donorCount = donors.length;
    const patientCount = patients.length;
    const highestDepartment = departmentUsage.find((item) => item.units > 0);
    const highestDepartmentSummary = highestDepartment ? '<div class="report-highlight"><strong>Highest receiving department:</strong> ' +
      escapeHtml(highestDepartment.department) + " received " + highestDepartment.units + " unit(s) (" +
      highestDepartment.percent.toFixed(1) + "% of units issued).</div>" : "";
    return reportIntro + periodHeading + '<div class="stat-grid">' + statCard("Total donors", donorCount) + statCard("Total patients", patientCount) +
      statCard("Male donors", maleDonors.length) + statCard("Female donors", femaleDonors.length) +
      statCard("Male patients", malePatients.length) + statCard("Female patients", femalePatients.length) +
      statCard("Units received", donorUnits) + statCard("Units issued", patientUnits) +
      statCard("Net units in period", donorUnits - patientUnits) + statCard("Donor amounts recorded", money(donorAmounts)) + '</div>' +
      highestDepartmentSummary + chartSet + renderDepartmentBloodGroupTable(departmentBreakdown) + renderBloodGroupIssueTable(patients) +
      '<section class="panel">' + table(["Rank", "Department", "Blood Units Received", "Percentage of Total"], departmentUsage.map((item, index) =>
        "<tr><td>" + (index + 1) + "</td><td>" + escapeHtml(item.department) + "</td><td>" + item.units + "</td><td>" + item.percent.toFixed(1) + "%</td></tr>"
      ), "No department data in this period.") + "</section>";
  }

  function reportPrintHeader(tab, range) {
    const titles = {
      donors: "Donor", patients: "Patient", departments: "Department",
      financial: "Financial", statistics: "Statistical Dashboard"
    };
    const user = state.user || {};
    const departmentAware = ["patients", "departments", "statistics"].includes(tab);
    const departmentLine = departmentAware ?
      '<p>Department: <strong>' + escapeHtml(range.department || "All departments") + "</strong></p>" : "";
    return '<img class="report-print-watermark" src="assets/images/hospital-logo.png" alt="">' +
      '<header class="report-print-header"><img src="assets/images/hospital-logo.png" alt="Magbenteh Community Hospital logo">' +
      '<div><h1>MAGBENTEH COMMUNITY HOSPITAL</h1><p>Blood Donation and Transfusion Management System (MCH-BDTMS)</p>' +
      '<h2>' + escapeHtml(titles[tab] || "Hospital") + ' Report</h2><p>Reporting period: <strong>' +
      escapeHtml(range.label) + "</strong></p>" + departmentLine + "<small>Prepared by: " +
      escapeHtml((user.fullName || "Unknown user") + (user.role ? " (" + user.role + ")" : "")) +
      " | Generated: " + escapeHtml(new Date().toLocaleString()) + "</small></div></header>";
  }

  function reportWrittenSummary(tab, range, donors, patients, departmentUsage, donorUnits, patientUnits, donorAmounts, allPatientUnits) {
    const paragraphs = [];
    const donationGroups = reportBloodGroups(donors, []);
    const issueGroups = reportBloodGroups([], patients);
    const topDonationGroup = donationGroups.slice().sort((a, b) => b.received - a.received)[0];
    const topIssueGroup = issueGroups.slice().sort((a, b) => b.issued - a.issued)[0];
    const highestDepartment = departmentUsage.find((item) => item.units > 0);
    const malePatientUnits = patients.filter((item) => item.sex === "Male")
      .reduce((sum, item) => sum + Number(item.units || 0), 0);
    const femalePatientUnits = patients.filter((item) => item.sex === "Female")
      .reduce((sum, item) => sum + Number(item.units || 0), 0);
    const departmentScope = range.department ? " for " + range.department : " across all departments";

    if (tab === "donors") {
      paragraphs.push(donors.length ?
        "For " + range.label + ", " + donors.length + " donation record(s) contributed " + donorUnits +
          " blood unit(s). This count represents recorded donation transactions, not necessarily distinct people." :
        "No donor records or donated blood units were recorded during " + range.label + ".");
      paragraphs.push("The records include " + donors.filter((item) => item.sex === "Male").length +
        " male and " + donors.filter((item) => item.sex === "Female").length + " female donor record(s). " +
        "The most donated group was " + (topDonationGroup && topDonationGroup.received ?
          topDonationGroup.group + " with " + topDonationGroup.received + " unit(s)." :
          "not applicable because no units were donated in this period."));
      paragraphs.push("A total of " + money(donorAmounts) + " was recorded against these donations. This is the amount recorded in the system and does not, by itself, confirm payment receipt.");
    } else if (tab === "patients") {
      paragraphs.push(patients.length ?
        "For " + range.label + ", " + patients.length + " patient record(s) accounted for " + patientUnits +
          " unit(s) issued" + departmentScope + ". Repeat records for the same person are counted as separate transactions." :
        "No patient records or issued blood units were recorded during " + range.label + departmentScope + ".");
      paragraphs.push("Male patients received " + malePatientUnits + " unit(s) (" + percentage(malePatientUnits, patientUnits).toFixed(1) +
        "% of units in this scope), and female patients received " + femalePatientUnits + " unit(s) (" +
        percentage(femalePatientUnits, patientUnits).toFixed(1) + "%). The most issued blood group was " +
        (topIssueGroup && topIssueGroup.issued ? topIssueGroup.group + " with " + topIssueGroup.issued + " unit(s)." :
          "not applicable because no units were issued."));
      paragraphs.push(highestDepartment ?
        highestDepartment.department + " was the highest receiving department, with " + highestDepartment.units +
          " unit(s) (" + highestDepartment.percent.toFixed(1) + "% of all units issued in the selected range)." :
        "No department received blood units in this reporting period.");
      paragraphs.push("The accompanying group-by-department table identifies the exact number and share of each blood group issued to each department. Period totals describe activity during the selected dates and are not the current bank balance.");
    } else if (tab === "departments") {
      paragraphs.push("During " + range.label + ", " + patientUnits + " unit(s) were issued" + departmentScope +
        ". The full hospital total for the same dates was " + allPatientUnits + " unit(s).");
      paragraphs.push(highestDepartment ?
        highestDepartment.department + " received the most blood in the selected scope: " + highestDepartment.units +
          " unit(s), or " + highestDepartment.percent.toFixed(1) + "% of the hospital total." :
        "No department received blood units in this period.");
      paragraphs.push("Across the selected scope, male patients received " + malePatientUnits + " unit(s) (" +
        percentage(malePatientUnits, patientUnits).toFixed(1) + "%) and female patients received " +
        femalePatientUnits + " unit(s) (" + percentage(femalePatientUnits, patientUnits).toFixed(1) +
        "%). The blood-group table reports units for every department; each group's percentage is calculated against that department's total.");
      paragraphs.push("These are patient issue totals, not separate department inventories. Blood-bank availability is tracked centrally by blood group, and reporting-period issues should not be interpreted as the current stock balance.");
    } else if (tab === "financial") {
      paragraphs.push("For " + range.label + ", " + money(donorAmounts) + " was recorded across " + donors.length +
        " donation record(s), representing " + donorUnits + " donated unit(s).");
      paragraphs.push("These figures summarize amounts stored with donor transactions; they are not a cashbook reconciliation and do not confirm that payment was received.");
    } else {
      paragraphs.push("For " + range.label + ", donors contributed " + donorUnits + " unit(s) and patients received " +
        patientUnits + " unit(s), producing net period activity of " + (donorUnits - patientUnits) + " unit(s)." +
        (range.department ? " Patient activity is filtered to " + range.department + "." : ""));
      paragraphs.push(highestDepartment ?
        highestDepartment.department + " received the most, with " + highestDepartment.units +
          " unit(s) (" + highestDepartment.percent.toFixed(1) + "% of the hospital's issued units)." :
        "No department received blood units in this period.");
      paragraphs.push("The most issued blood group was " + (topIssueGroup && topIssueGroup.issued ?
        topIssueGroup.group + " with " + topIssueGroup.issued + " unit(s)." : "not applicable because no units were issued.") +
        " The accompanying tables show the department and blood-group distribution, while the charts summarize activity across the selected range.");
      paragraphs.push("Net period activity is not a complete inventory balance: donations or issues from earlier periods can remain in the bank. Current stock must be read from the live blood-bank dashboard.");
    }
    return '<section class="panel report-narrative"><h3>Written analysis</h3>' +
      paragraphs.map((text) => "<p>" + escapeHtml(text) + "</p>").join("") + "</section>";
  }

  function reportBloodGroups(donors, patients) {
    return ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"].map((group) => ({
      group: group,
      received: donors.filter((item) => item.bloodGroup === group).reduce((sum, item) => sum + Number(item.units || 0), 0),
      issued: patients.filter((item) => (item.issuedBloodGroup || item.bloodGroup) === group)
        .reduce((sum, item) => sum + Number(item.units || 0), 0)
    }));
  }

  function reportMonthlyTotals(donors, patients, range) {
    const totals = new Map();
    const startParts = range.start.split("-").map(Number);
    const endParts = range.end.split("-").map(Number);
    const selectedDayCount = (Date.UTC(endParts[0], endParts[1] - 1, endParts[2]) -
      Date.UTC(startParts[0], startParts[1] - 1, startParts[2])) / 86400000 + 1;
    const dailyBuckets = range.period === "Daily" && selectedDayCount <= 90;
    let cursor = dailyBuckets ?
      new Date(Date.UTC(startParts[0], startParts[1] - 1, startParts[2])) :
      new Date(Date.UTC(startParts[0], startParts[1] - 1, 1));
    const lastBucket = dailyBuckets ?
      Date.UTC(endParts[0], endParts[1] - 1, endParts[2]) :
      Date.UTC(endParts[0], endParts[1] - 1, 1);
    while (cursor.getTime() <= lastBucket) {
      const key = cursor.toISOString().slice(0, dailyBuckets ? 10 : 7);
      totals.set(key, { received: 0, issued: 0, amount: 0 });
      if (dailyBuckets) cursor.setUTCDate(cursor.getUTCDate() + 1);
      else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }

    donors.concat(patients).forEach((item) => {
      const date = String(item.date || "").slice(0, 10);
      const key = dailyBuckets ? date : date.slice(0, 7);
      if (key && !totals.has(key)) totals.set(key, { received: 0, issued: 0, amount: 0 });
    });
    donors.forEach((item) => {
      const date = String(item.date || "").slice(0, 10);
      const key = dailyBuckets ? date : date.slice(0, 7);
      if (key && totals.has(key)) {
        totals.get(key).received += Number(item.units || 0);
        totals.get(key).amount += Number(item.amount || 0);
      }
    });
    patients.forEach((item) => {
      const date = String(item.date || "").slice(0, 10);
      const key = dailyBuckets ? date : date.slice(0, 7);
      if (key && totals.has(key)) totals.get(key).issued += Number(item.units || 0);
    });
    return Array.from(totals.entries()).sort((a, b) => a[0].localeCompare(b[0])).map((entry) => {
      const [year, month, day] = entry[0].split("-").map(Number);
      const label = dailyBuckets ?
        new Date(year, month - 1, day).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" }) :
        reportMonths[month - 1].slice(0, 3) + " " + year;
      return { label: label, received: entry[1].received, issued: entry[1].issued, amount: entry[1].amount };
    });
  }

  function renderReportChartSuite(tab, donors, patients, departmentUsage, timeSeries) {
    const groups = reportBloodGroups(donors, patients);
    const departmentItems = departmentUsage.map((item) => ({
      label: item.department, value: item.units, detail: item.units + " units - " + item.percent.toFixed(1) + "%"
    }));
    const groupItems = groups.map((item) => ({
      label: item.group, value: item.received + item.issued,
      detail: item.received + " received / " + item.issued + " issued"
    }));
    const timeline = timeSeries.map((item) => item.label);
    let barTitle;
    let barItems;
    let pieTitle;
    let pieDescription;
    let pieItems;
    let histogramTitle;
    let histogramItems;
    let lineTitle;
    let lineSeries;
    let valueFormatter;

    if (tab === "donors") {
      barTitle = "Donated units by period";
      barItems = timeSeries.map((item) => ({ label: item.label, value: item.received }));
      pieTitle = "Donations by blood group";
      pieDescription = "Share of donated units by blood group.";
      pieItems = groups.map((item) => ({ label: item.group, value: item.received }));
      histogramTitle = "Donated-unit histogram";
      histogramItems = groups.map((item) => ({ label: item.group, value: item.received }));
      lineTitle = "Donation trend";
      lineSeries = [{ name: "Units donated", color: reportChartColors[0], values: timeSeries.map((item) => item.received) }];
    } else if (tab === "patients") {
      barTitle = "Issued units by period";
      barItems = timeSeries.map((item) => ({ label: item.label, value: item.issued }));
      pieTitle = "Patient records by sex";
      pieDescription = "Male and female patient record distribution.";
      pieItems = [
        { label: "Male", value: patients.filter((item) => item.sex === "Male").length, color: reportChartColors[0] },
        { label: "Female", value: patients.filter((item) => item.sex === "Female").length, color: reportChartColors[2] }
      ];
      histogramTitle = "Units issued by department";
      histogramItems = departmentItems;
      lineTitle = "Transfusion trend";
      lineSeries = [{ name: "Units issued", color: reportChartColors[1], values: timeSeries.map((item) => item.issued) }];
    } else if (tab === "departments") {
      barTitle = "Units by department";
      barItems = departmentItems;
      pieTitle = "Department share of issued units";
      pieDescription = "Each department's share of blood issued in the selected range.";
      pieItems = departmentUsage.map((item) => ({ label: item.department, value: item.units }));
      histogramTitle = "Department unit-share histogram";
      histogramItems = departmentUsage.map((item) => ({
        label: item.department, value: item.percent, detail: item.units + " units - " + item.percent.toFixed(1) + "%"
      }));
      lineTitle = "Units issued over time";
      lineSeries = [{ name: "Units issued", color: reportChartColors[1], values: timeSeries.map((item) => item.issued) }];
    } else if (tab === "financial") {
      const amountsByGroup = groups.map((group) => ({
        label: group.group,
        value: donors.filter((item) => item.bloodGroup === group.group).reduce((sum, item) => sum + Number(item.amount || 0), 0)
      }));
      barTitle = "Recorded amount by period";
      barItems = timeSeries.map((item) => ({ label: item.label, value: item.amount }));
      pieTitle = "Recorded amounts by blood group";
      pieDescription = "Distribution of recorded donation amounts, not confirmed payments.";
      pieItems = amountsByGroup;
      histogramTitle = "Monthly recorded-amount histogram";
      histogramItems = timeSeries.map((item) => ({ label: item.label, value: item.amount }));
      lineTitle = "Recorded amount trend";
      lineSeries = [{ name: "Recorded amount (Le)", color: reportChartColors[2], values: timeSeries.map((item) => item.amount) }];
      valueFormatter = money;
    } else {
      barTitle = "Department units issued";
      barItems = departmentItems;
      pieTitle = "Donation and issue unit mix";
      pieDescription = "Total donation activity compared with transfusion activity.";
      pieItems = [
        { label: "Units donated", value: donors.reduce((sum, item) => sum + Number(item.units || 0), 0), color: reportChartColors[0] },
        { label: "Units issued", value: patients.reduce((sum, item) => sum + Number(item.units || 0), 0), color: reportChartColors[1] }
      ];
      histogramTitle = "Blood-group unit histogram";
      histogramItems = groupItems;
      lineTitle = "Donations and transfusions over time";
      lineSeries = [
        { name: "Units donated", color: reportChartColors[0], values: timeSeries.map((item) => item.received) },
        { name: "Units issued", color: reportChartColors[1], values: timeSeries.map((item) => item.issued) }
      ];
    }

    const series = lineSeries || [];
    return '<div class="report-visual-grid">' +
      barChart(barTitle, "Compare values across the selected reporting range.", barItems, valueFormatter) +
      pieChart(pieTitle, pieDescription, pieItems, valueFormatter) +
      histogram(histogramTitle, "Distribution for the selected reporting range.", histogramItems, tab === "departments" ?
        (value) => value.toFixed(1) + "%" : valueFormatter) +
      lineChart(lineTitle, "Trend over the selected reporting range.", timeline, series, valueFormatter) + "</div>";
  }

  function updateReportPeriodControls() {
    const period = $("#report-period");
    if (!period) return;
    const singleMonth = period.value === "Single month";
    const monthlyRange = period.value === "Monthly";
    const singleQuarter = period.value === "Single quarter";
    const quarterlyRange = period.value === "Quarterly";
    const halfYearRange = period.value === "Half-Yearly";
    const singleYear = period.value === "Single year";
    const yearlyRange = period.value === "Annual / Yearly";
    const visible = {
      yearFrom: !["Custom range", "Daily"].includes(period.value),
      yearTo: monthlyRange || quarterlyRange || halfYearRange || yearlyRange,
      monthFrom: singleMonth || monthlyRange,
      monthTo: monthlyRange,
      quarterFrom: singleQuarter || quarterlyRange,
      quarterTo: quarterlyRange,
      halfYearFrom: halfYearRange,
      halfYearTo: halfYearRange,
      fromDate: period.value === "Custom range" || period.value === "Daily",
      toDate: period.value === "Custom range" || period.value === "Daily"
    };
    $$("[data-report-control]").forEach((control) => {
      control.classList.toggle("hidden", !visible[control.dataset.reportControl]);
    });
    const monthLabel = $('[data-report-label="monthFrom"]');
    const quarterLabel = $('[data-report-label="quarterFrom"]');
    const yearLabel = $('[data-report-label="yearFrom"]');
    if (monthLabel) monthLabel.textContent = singleMonth ? "Month" : "Month from";
    if (quarterLabel) quarterLabel.textContent = singleQuarter ? "Quarter" : "Quarter from";
    if (yearLabel) yearLabel.textContent = singleYear ? "Year" : "Year from";
  }

  function refreshReportResults() {
    const form = $("#report-filter-form");
    const results = $("#report-results");
    if (!form || !results || !state.cache.reportData) return;
    const filters = Object.fromEntries(new FormData(form).entries());
    try {
      const range = reportDateRange(filters);
      results.innerHTML = renderReportResults(state.reportTab, state.cache.reportData, range);
    } catch (error) {
      results.innerHTML = '<div class="notice error">' + escapeHtml(error.message) + "</div>";
    }
  }

  async function renderRecycle() {
    const items = await request("listRecycleBin");
    const canManage = state.user.role === "Administrator";
    const emptyAction = canManage && items.length ?
      '<button class="button button-danger" data-action="empty-recycle-bin" title="Permanently delete every item in the Recycle Bin" aria-label="Empty Recycle Bin">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m5 4v6m4-6v6"/></svg>' +
      '<span>Empty Recycle Bin</span></button>' : "";
    const rows = items.map((item, index) => {
      const actions = canManage ?
        '<div class="table-actions"><button class="button button-secondary button-small" data-action="restore" data-type="' +
        escapeHtml(item.type) + '" data-id="' + escapeHtml(item.id) + '">Restore</button><button class="button button-danger button-small" data-action="permanent-delete" data-type="' +
        escapeHtml(item.type) + '" data-id="' + escapeHtml(item.id) + '" data-label="' + escapeHtml(item.label) + '" title="Permanently delete this record">Delete</button></div>' :
        '<span class="subtle">Administrator only</span>';
      return "<tr><td>" + (index + 1) + "</td><td>" + escapeHtml(item.type) + "</td><td>" + escapeHtml(item.label) +
        "</td><td>" + escapeHtml(item.deletedAt || "—") + "</td><td>" + actions + "</td></tr>";
    });
    return pageHeading("Recycle bin", canManage ?
      "Restore deleted records or permanently delete them. Emptying the bin cannot be undone." :
      "Deleted records are kept here. An Administrator can restore or permanently delete them.", emptyAction) +
      '<section class="panel">' + table(["S/N", "Record type", "Record", "Deleted at", "Actions"], rows, "The recycle bin is empty.") + "</section>";
  }

  async function renderAdmin() {
    if (state.user.role !== "Administrator") throw new Error("Administrator access is required.");
    const data = await request("adminOverview");
    state.cache.admin = data;
    const userRows = data.users.map((item, index) => {
      const status = item.status === "PENDING" ? '<span class="status-pill pending">Pending</span>' : '<span class="status-pill">Active</span>';
      const roleOptions = ["Lab Technician", "Administrator"].map((role) => '<option value="' + role + '"' +
        (item.role === role ? " selected" : "") + ">" + role + "</option>").join("");
      const approve = item.status === "PENDING" ? '<button class="button button-primary button-small" data-action="approve-user" data-id="' + escapeHtml(item.id) + '">Approve</button>' :
        '<button class="button button-secondary button-small" data-action="save-user-role" data-id="' + escapeHtml(item.id) + '">Save role</button>';
      const emailAgain = item.status === "ACTIVE" ? '<button class="button button-secondary button-small" data-action="resend-approval-email" data-id="' +
        escapeHtml(item.id) + '" title="Resend account approval email">Email again</button>' : "";
      return "<tr><td>" + (index + 1) + "</td><td>" + escapeHtml(item.fullName) + "</td><td>" + escapeHtml(item.username) + "</td><td>" + escapeHtml(item.email) + "</td><td>" +
        '<select aria-label="Role for ' + escapeHtml(item.fullName) + '" data-user-role="' + escapeHtml(item.id) + '">' + roleOptions + "</select></td><td>" + status + '</td><td><div class="table-actions">' + approve + emailAgain +
        '<button class="button button-danger button-small" data-action="delete-user" data-id="' + escapeHtml(item.id) + '" data-label="' + escapeHtml(item.fullName) +
        '">Delete</button></div></td></tr>';
    });
    const deptRows = data.departments.map((item, index) => "<tr><td>" + (index + 1) + "</td><td>" + escapeHtml(item.name) + "</td><td><span class=\"status-pill\">Active</span></td></tr>");
    return pageHeading("Admin control panel", "Manage access, departments, and donor payment amounts.", "") +
      '<div class="admin-tabs"><button class="tab-button active" data-admin-tab="users">User management (' + data.users.length + ')</button><button class="tab-button" data-admin-tab="departments">Departments</button><button class="tab-button" data-admin-tab="payments">Payment settings</button></div>' +
      '<section class="panel admin-panel" data-admin-panel="users"><div class="panel-head"><div><h2>User management</h2><p>Approve new accounts or remove user access.</p></div></div>' +
      table(["S/N", "Name", "Username", "Email", "Role", "Status", "Actions"], userRows, "No user accounts found.") + "</section>" +
      '<section class="panel admin-panel hidden" data-admin-panel="departments"><div class="panel-head"><div><h2>Departments</h2><p>Available to choose on patient records.</p></div><button class="button button-primary" data-action="add-department">＋ Add department</button></div>' +
      table(["S/N", "Department", "Status"], deptRows, "No departments have been added.") + "</section>" +
      '<section class="panel admin-panel hidden" data-admin-panel="payments"><div class="panel-head"><div><h2>Donor amount</h2><p>Default amount automatically added to new donor records.</p></div></div>' +
      '<form id="settings-form" class="form-grid form-watermark"><label>Default amount (Le)<input name="donorAmount" inputmode="numeric" value="' + escapeHtml(Number(data.donorAmount || 0).toLocaleString("en-US")) + '" required></label>' +
      '<div class="full-width"><button class="button button-primary" type="submit">Save amount</button></div></form><p class="subtle">Amounts display with thousands separators (for example, Le 2,000).</p></section>';
  }

  async function renderProfile() {
    const user = await request("getProfile");
    state.user = user;
    $("#top-user-name").textContent = user.fullName;
    $("#top-user-photo").src = user.photo || "assets/images/avatar-placeholder.svg";
    return pageHeading("My profile", "Update your login username, contact information, and photo.", "") +
      '<div class="profile-grid"><section class="panel profile-photo-panel"><img class="profile-photo" src="' + escapeHtml(user.photo || "assets/images/avatar-placeholder.svg") +
      '" alt="Profile photo"><strong>' + escapeHtml(user.fullName) + '</strong><small>' + escapeHtml(user.role) + '</small><label class="field-label">Profile photo<input id="profile-photo-input" type="file" accept="image/*"></label><button class="button button-danger button-small' + (user.photo ? "" : " hidden") + '" type="button" data-action="remove-profile-photo">Remove photo</button><span class="subtle">JPG, PNG, or WebP; any dimensions are resized to fit the circle.</span></section>' +
      '<section class="panel"><h2>Personal information</h2><form id="profile-form" class="form-grid form-watermark" data-user-id="' + escapeHtml(user.id) + '">' +
      '<label>Full name<input name="fullName" value="' + escapeHtml(user.fullName) + '" required maxlength="100"></label><label>Username<input name="username" value="' +
      escapeHtml(user.username) + '" autocapitalize="none" spellcheck="false" minlength="3" maxlength="30" pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,29}" required></label><label>Email address<input name="email" type="email" value="' +
      escapeHtml(user.email) + '" required maxlength="150"></label><label>Phone number<input name="phone" type="tel" value="' + escapeHtml(user.phone || "") + '" maxlength="30"></label>' +
      '<label>Department<input name="department" value="' + escapeHtml(user.department || "") + '" maxlength="100"></label><div class="full-width"><button class="button button-primary" type="submit">Save profile</button></div></form></section></div>';
  }

  function bloodOptions(selected) {
    return ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"].map((group) => '<option value="' + group + '"' +
      (group === selected ? " selected" : "") + ">" + group + "</option>").join("");
  }

  function formField(label, name, type, value, required, extra) {
    const attrs = extra || "";
    return '<label>' + escapeHtml(label) + '<input name="' + name + '" type="' + type + '" value="' + escapeHtml(value || "") + '"' +
      (required ? " required" : "") + " " + attrs + "></label>";
  }

  function refreshPatientAllocationPreview(form) {
    const status = $("#blood-allocation-status", form);
    if (!status || form.dataset.type !== "patient") return;
    clearTimeout(patientPreviewTimer);
    const requestId = ++patientPreviewRequestId;
    const bloodGroup = $('[name="bloodGroup"]', form).value;
    const units = Number($('[name="units"]', form).value);
    status.classList.remove("error", "is-compatible", "is-alternative");
    if (!bloodGroup || !Number.isInteger(units) || units < 1) {
      status.textContent = "Select the patient's blood group and a whole number of units to check compatible stock.";
      return;
    }

    status.textContent = "Checking compatible blood-bank stock…";
    patientPreviewTimer = setTimeout(async () => {
      try {
        const allocation = await request("previewPatientIssue", {
          bloodGroup: bloodGroup,
          units: units,
          id: form.dataset.recordId || ""
        }, true);
        if (requestId !== patientPreviewRequestId || !form.isConnected) return;
        status.textContent = allocation.message;
        status.classList.toggle("error", !allocation.available);
        status.classList.toggle("is-compatible", allocation.available);
        status.classList.toggle("is-alternative",
          allocation.available && allocation.issuedBloodGroup !== allocation.patientBloodGroup);
      } catch (error) {
        if (requestId !== patientPreviewRequestId || !form.isConnected) return;
        status.textContent = error.message;
        status.classList.add("error");
      }
    }, 250);
  }

  async function openRecordForm(type, record) {
    const editing = Boolean(record);
    const isDonor = type === "donor";
    const dialog = $("#record-dialog");
    const dialogContent = $("#dialog-content");
    openDialog('<div class="form-loading" role="status"><span class="loading-spinner"></span><span>Preparing the ' +
      (isDonor ? "donor" : "patient") + ' form…</span></div>');
    try {
      const departments = isDonor ? [] : await request("getDepartments");
      const setting = isDonor ? await request("getSettings") : {};
      if (!dialog.open) return;
      const sexOptions = '<option value="">Select sex</option><option value="Male"' + (record && record.sex === "Male" ? " selected" : "") +
        '>Male</option><option value="Female"' + (record && record.sex === "Female" ? " selected" : "") + ">Female</option>";
      const departmentOptions = departments.map((item) => '<option value="' + escapeHtml(item.name) + '"' +
        (record && record.department === item.name ? " selected" : "") + ">" + escapeHtml(item.name) + "</option>").join("");
      const formId = editing ? ' data-record-id="' + escapeHtml(record.id) + '"' : "";
      const html = '<h2 class="dialog-title">' + (editing ? "Edit " : "Add ") + (isDonor ? "donor" : "patient") +
        " record</h2><p class=\"dialog-description\">Enter the " + (isDonor ? "donation details." : "patient and transfusion details.") +
        '</p><form id="record-form" class="form-watermark" data-type="' + type + '"' + formId + '><div class="form-grid">' +
        formField("Full name", "name", "text", record ? record.name : "", true, 'maxlength="100"') +
        formField("Date", "date", "date", record ? record.date : today(), true, "") +
        formField("Time", "time", "time", record ? record.time : new Date().toTimeString().slice(0, 5), true, "") +
        '<label>' + (isDonor ? "Blood group" : "Patient blood group") + '<select name="bloodGroup" required><option value="">Select blood group</option>' +
        bloodOptions(record && record.bloodGroup) + "</select></label>" +
        '<label>Sex<select name="sex" required>' + sexOptions + "</select></label>" +
        formField("Age", "age", "number", record ? record.age : "", !isDonor, 'min="0" max="120"') +
        formField("Blood units", "units", "number", record ? record.units : "1", true, 'min="1" step="1"') +
        (isDonor ? formField("Receipt number", "receiptNumber", "text", record ? record.receiptNumber : "", false, 'maxlength="50"') +
          formField("Amount (Le)", "amount", "text", Number(record ? record.amount : setting.donorAmount || 0).toLocaleString("en-US"), true, 'inputmode="numeric" readonly aria-readonly="true"') :
          '<label>Department<select name="department" required><option value="">Select department</option>' + departmentOptions + "</select></label>" +
          '<div class="full-width"><p class="allocation-caption">Standard red-cell ABO/Rh compatibility is checked against current bank stock.</p>' +
          '<div id="blood-allocation-status" class="blood-allocation-status notice" role="status" aria-live="polite">Select the patient blood group and units to check compatible stock.</div></div>') +
        '</div><div class="dialog-actions"><button type="button" class="button button-secondary" data-action="close-dialog">Cancel</button><button class="button button-primary" type="submit">' +
        (editing ? "Save changes" : "Save record") + "</button></div></form>";
      dialogContent.innerHTML = html;
      if (!isDonor) refreshPatientAllocationPreview($("#record-form"));
    } catch (error) {
      if (!dialog.open) return;
      const recordId = editing ? ' data-id="' + escapeHtml(record.id) + '"' : "";
      dialogContent.innerHTML = '<section class="notice error" role="alert">' + escapeHtml(error.message) +
        '</section><div class="dialog-actions"><button type="button" class="button button-secondary" data-action="close-dialog">Close</button>' +
        '<button type="button" class="button button-primary" data-action="retry-record-form" data-type="' + (isDonor ? "donor" : "patient") +
        '"' + recordId + '>Try again</button></div>';
    }
  }

  function openDialog(content) {
    $("#dialog-content").innerHTML = content;
    const dialog = $("#record-dialog");
    if (!dialog.open) dialog.showModal();
  }

  function csvExport(type) {
    const records = state.cache[type] || [];
    if (!records.length) return showToast("There are no records to export.", true);
    const keys = type === "donors" ? ["date", "time", "bloodGroup", "name", "sex", "units", "receiptNumber", "amount", "personnel"] :
      ["date", "time", "bloodGroup", "issuedBloodGroup", "name", "age", "sex", "department", "units", "personnel"];
    const csv = [keys.join(","), ...records.map((item) => keys.map((key) => '"' + String(item[key] == null ? "" : item[key]).replace(/"/g, '""') + '"').join(","))].join("\r\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    link.download = "mch-bdtms-" + type + "-" + today() + ".csv";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  async function handleAction(button) {
    const action = button.dataset.action;
    const type = button.dataset.type;
    const id = button.dataset.id;
    if (action === "add-donor" || action === "add-patient") return openRecordForm(action === "add-donor" ? "donor" : "patient");
    if (action === "close-dialog") return $("#record-dialog").close();
    if (action === "retry-record-form") {
      const record = button.dataset.id ?
        (state.cache[button.dataset.type === "donor" ? "donors" : "patients"] || []).find((item) => item.id === button.dataset.id) : null;
      if (button.dataset.id && !record) return showToast("Record not found. Refresh the table and try again.", true);
      return openRecordForm(button.dataset.type, record);
    }
    if (action === "print") return window.print();
    if (action === "refresh") return navigate(state.page);
    if (action === "export") return csvExport(type);
    if (action === "view") {
      const item = (state.cache[type === "donor" ? "donors" : "patients"] || []).find((record) => record.id === id);
      if (!item) return;
      openDialog('<h2 class="dialog-title">' + escapeHtml(item.name) + '</h2><p class="dialog-description">' + escapeHtml(type) + ' record details</p><div class="summary-list">' +
        Object.keys(item).filter((key) => !["id", "deletedAt"].includes(key)).map((key) => '<div class="summary-line"><span>' + escapeHtml(key) + '</span><strong>' +
          escapeHtml(key === "amount" ? money(item[key]) : item[key]) + "</strong></div>").join("") + "</div>");
      return;
    }
    if (action === "edit") {
      const item = (state.cache[type === "donor" ? "donors" : "patients"] || []).find((record) => record.id === id);
      if (!item) return showToast("Record not found. Refresh the table and try again.", true);
      return openRecordForm(type, item);
    }
    if (action === "remove-profile-photo") {
      const form = $("#profile-form");
      if (!form) return;
      form.dataset.photo = "";
      form.dataset.removePhoto = "true";
      $(".profile-photo").src = "assets/images/avatar-placeholder.svg";
      button.classList.add("hidden");
      return showToast("Photo marked for removal. Save your profile to apply it.");
    }
    if (action === "delete") {
      if (!await showConfirmDialog("Move record to Recycle Bin", "Move " + (button.dataset.label || "this record") +
        " to the Recycle Bin? An Administrator can restore it later.", "Move to Recycle Bin")) return;
      await request(type === "donor" ? "deleteDonor" : "deletePatient", { id: id });
      showSuccessDialog("Record moved to Recycle Bin", "The record was deleted and can be restored by an Administrator.");
      refreshLowStockNavigationAfterMutation();
      return navigate(state.page);
    }
    if (action === "permanent-delete") {
      if (state.user.role !== "Administrator") return showToast("Administrator access is required.", true);
      if (!await showConfirmDialog("Permanently delete record", "Permanently delete " + (button.dataset.label || "this record") +
        "? This action cannot be undone.", "Delete permanently")) return;
      await request("permanentlyDeleteRecord", { type: type, id: id });
      showSuccessDialog("Record permanently deleted", "The selected record has been removed and cannot be restored.");
      return navigate(state.page);
    }
    if (action === "empty-recycle-bin") {
      if (state.user.role !== "Administrator") return showToast("Administrator access is required.", true);
      if (!await showConfirmDialog("Empty Recycle Bin",
        "Permanently delete all donor, patient, and deleted user records currently in the Recycle Bin? This cannot be undone.",
        "Empty Recycle Bin")) return;
      const result = await request("emptyRecycleBin");
      showSuccessDialog("Recycle Bin emptied", result.totalDeleted ?
        result.totalDeleted + " item(s) were permanently deleted." : "The Recycle Bin was already empty.");
      return navigate("recycle");
    }
    if (action === "approve-user") {
      const roleSelect = $("[data-user-role='" + id + "']");
      const result = await request("approveUser", { id: id, role: roleSelect ? roleSelect.value : "Lab Technician" });
      showSuccessDialog(result.emailSent ? "User approved" : "User approved; email not sent",
        result.emailSent ? "The account is active and an approval email was sent." :
          "The account is active, but the approval email failed: " + (result.emailError || "Unknown email error."));
      return navigate("admin");
    }
    if (action === "resend-approval-email") {
      const result = await request("resendApprovalEmail", { id: id });
      showToast(result.emailSent ? "Approval email sent again." :
        "Email could not be sent: " + (result.emailError || "Unknown email error."), !result.emailSent);
      return navigate("admin");
    }
    if (action === "save-user-role") {
      const roleSelect = $("[data-user-role='" + id + "']");
      if (!roleSelect) return;
      await request("setUserRole", { id: id, role: roleSelect.value });
      showSuccessDialog("User role updated", "The account role was saved successfully.");
      if (id === state.user.id && roleSelect.value !== "Administrator") return showLogin();
      return navigate("admin");
    }
    if (action === "delete-user") {
      if (!await showConfirmDialog("Delete user account", "Move " + (button.dataset.label || "this user's account") +
        " to the Recycle Bin? An Administrator can restore it later.", "Delete account")) return;
      const result = await request("deleteUser", { id: id });
      showSuccessDialog("User account deleted", "The account was moved to the Recycle Bin.");
      if (result.self) return showLogin();
      return navigate("admin");
    }
    if (action === "add-department") {
      openDialog('<h2 class="dialog-title">Add departments</h2><p class="dialog-description">Add one or more departments for patient records.</p><form id="department-form" class="form-grid form-watermark">' +
        '<div id="department-fields" class="department-fields full-width"><label>Department name 1<input name="departmentNames" required maxlength="100" placeholder="e.g. Emergency"></label></div>' +
        '<button type="button" class="button button-secondary department-add-field" data-action="add-department-field">＋ Add another department</button>' +
        '<div class="dialog-actions full-width"><button type="button" class="button button-secondary" data-action="close-dialog">Cancel</button><button type="submit" class="button button-primary">Add departments</button></div></form>');
      return;
    }
    if (action === "add-department-field") {
      const container = $("#department-fields");
      if (!container) return;
      if (container.children.length >= 20) return showToast("You can add up to 20 departments at a time.", true);
      const label = document.createElement("label");
      label.textContent = "Department name " + (container.children.length + 1);
      const input = document.createElement("input");
      input.name = "departmentNames";
      input.maxLength = 100;
      input.required = true;
      input.placeholder = "e.g. Emergency";
      label.appendChild(input);
      container.appendChild(label);
      input.focus();
      return;
    }
    if (action === "restore") {
      const restored = await request("restoreRecord", { type: type, id: id });
      const substituteNotice = restored.issuedBloodGroup &&
        restored.issuedBloodGroup !== restored.patientBloodGroup
        ? " Patient blood group " + restored.patientBloodGroup + " was retained, with compatible " +
          restored.issuedBloodGroup + " blood assigned."
        : "";
      showSuccessDialog("Record restored", "The record has been returned to its original list." + substituteNotice);
      if (type === "Donor" || type === "Patient") refreshLowStockNavigationAfterMutation();
      return navigate("recycle");
    }
  }

  function applyFilters() {
    const page = state.page;
    const query = (page === "donors" ? $('[data-filter="donors"]') : $('[data-filter="patients"]'));
    if (!query) return;
    const value = query.value.trim().toLowerCase();
    const group = $("[data-filter='" + (page === "donors" ? "donor-group" : "patient-group") + "']").value;
    const department = page === "patients" ? $("[data-filter='patient-department']").value : "";
    const filteredRows = (state.cache[page] || []).filter((item) => {
      const matchesName = !value || (String(item.name || "").toLowerCase().includes(value) ||
        (page === "donors" && String(item.receiptNumber || "").toLowerCase().includes(value)));
      return matchesName && (!group || item.bloodGroup === group);
    });
    const rows = page === "patients" && department ?
      filteredRows.filter((item) => item.department === department) : filteredRows;
    const tbody = $("#" + (page === "donors" ? "donor-records" : "patient-records") + " tbody");
    if (!tbody) return;
    const markup = page === "donors" ? rows.map((item, index) => '<tr><td>' + (index + 1) + "</td><td>" + escapeHtml(dateLabel(item.date)) + "</td><td>" +
      escapeHtml(item.time || "—") + "</td><td>" + escapeHtml(item.bloodGroup) + "</td><td>" + escapeHtml(item.name) + "</td><td>" + escapeHtml(formatSex(item.sex)) +
      "</td><td>" + escapeHtml(item.units) + "</td><td>" + escapeHtml(item.receiptNumber || "—") + "</td><td>" + money(item.amount) + "</td><td>" +
      escapeHtml(item.personnel || "—") + "</td><td>" + recordActions("donor", item.id, item.name) + "</td></tr>") :
      rows.map((item, index) => '<tr><td>' + (index + 1) + "</td><td>" + escapeHtml(dateLabel(item.date)) + "</td><td>" + escapeHtml(item.time || "—") + "</td><td>" +
      escapeHtml(item.bloodGroup) + "</td><td>" + escapeHtml(item.issuedBloodGroup || item.bloodGroup) + "</td><td>" + escapeHtml(item.name) + "</td><td>" +
      escapeHtml(item.age || "—") + "</td><td>" + escapeHtml(formatSex(item.sex)) + "</td><td>" + escapeHtml(item.department || "—") +
      "</td><td>" + escapeHtml(item.units) + "</td><td>" + escapeHtml(item.personnel || "—") + "</td><td>" +
      recordActions("patient", item.id, item.name) + "</td></tr>");
    tbody.innerHTML = markup.length ? markup.join("") : emptyRow(11 + (page === "patients" ? 1 : 0), "No matching records.");
    if (page === "patients") updatePatientSummary(rows, filteredRows);
  }

  async function handleSubmit(form) {
    const data = Object.fromEntries(new FormData(form).entries());
    if (form.id === "login-form") {
      const result = await request("login", data);
      state.token = result.token;
      localStorage.setItem("mchToken", state.token);
      showApp(result.user);
      return;
    }
    if (form.id === "register-form") {
      if (data.password !== data.confirmPassword) throw new Error("The passwords do not match.");
      delete data.confirmPassword;
      const result = await request("register", data);
      const loginUsername = $('#login-form [name="username"]');
      if (loginUsername) loginUsername.value = String(data.username || "").trim();
      if (result.status === "ACTIVE") {
        setAuthMode("login");
        showAuthMessage("Your Administrator account is ready. Sign in with your username, password, and Administrator role.");
      } else {
        setAuthMode("login");
        showAuthMessage("Registration received. An Administrator must approve your account before you can sign in with your selected role.");
      }
      return;
    }
    if (form.id === "record-form") {
      const isDonor = form.dataset.type === "donor";
      if (isDonor) data.amount = Number(String(data.amount).replace(/[^\d.]/g, ""));
      data.personnel = state.user.fullName;
      if (form.dataset.recordId) data.id = form.dataset.recordId;
      const saved = await request(isDonor ? "saveDonor" : "savePatient", data);
      $("#record-dialog").close();
      const substituteNotice = !isDonor && saved.issuedBloodGroup &&
        saved.issuedBloodGroup !== (saved.patientBloodGroup || data.bloodGroup)
        ? " Patient blood group " + (saved.patientBloodGroup || data.bloodGroup) + " was recorded, and compatible " +
          saved.issuedBloodGroup + " blood was issued because the requested group did not have enough stock."
        : "";
      const saveMessage = form.dataset.recordId ?
        "The " + (isDonor ? "donor" : "patient") + " record was updated successfully." :
        "The " + (isDonor ? "donor" : "patient") + " record was saved successfully.";
      showSuccessDialog(form.dataset.recordId ? "Record updated" : "Record saved", saveMessage + substituteNotice);
      refreshLowStockNavigationAfterMutation();
      return navigate(state.page);
    }
    if (form.id === "department-form") {
      const names = new FormData(form).getAll("departmentNames").map((name) => String(name).trim());
      await request("addDepartments", { names: names });
      $("#record-dialog").close();
      showSuccessDialog("Departments added", names.length === 1 ?
        "The department is now available on patient forms." : names.length + " departments are now available on patient forms.");
      return navigate("admin");
    }
    if (form.id === "settings-form") {
      data.donorAmount = Number(String(data.donorAmount).replace(/[^\d.]/g, ""));
      await request("updateSettings", data);
      showSuccessDialog("Payment setting saved", "The default donor amount was updated successfully.");
      return navigate("admin");
    }
    if (form.id === "profile-form") {
      const photo = form.dataset.photo || "";
      const removePhoto = form.dataset.removePhoto === "true";
      const usernameChanged = String(data.username || "").trim().toLowerCase() !== String(state.user.username || "").toLowerCase();
      const user = await request("updateProfile", Object.assign(data, { photo: photo, removePhoto: removePhoto }));
      showSuccessDialog("Profile updated", usernameChanged ?
        "Your changes were saved. Use your new username next time you sign in." : "Your profile changes were saved successfully.");
      return renderProfile().then((html) => {
        $("#page-content").innerHTML = html;
        $("#top-user-name").textContent = user.fullName;
        $("#top-user-photo").src = user.photo || "assets/images/avatar-placeholder.svg";
      });
    }
    if (form.id === "report-filter-form") {
      refreshReportResults();
    }
  }

  async function setProfilePhoto(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return showToast("Choose a JPG, PNG, or WebP image.", true);
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement("canvas");
        let maxDimension = 240;
        let quality = .7;
        let photo = "";
        do {
          const ratio = Math.min(1, maxDimension / Math.max(image.width, image.height));
          canvas.width = Math.max(1, Math.round(image.width * ratio));
          canvas.height = Math.max(1, Math.round(image.height * ratio));
          canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
          photo = canvas.toDataURL("image/jpeg", quality);
          if (photo.length <= 45000) break;
          if (quality > .4) quality = Math.max(.4, quality - .1);
          else maxDimension = Math.round(maxDimension * .8);
        } while (maxDimension >= 64);
        if (photo.length > 45000) return showToast("This photo could not be compressed enough. Choose another image.", true);
        $("#profile-form").dataset.photo = photo;
        $("#profile-form").dataset.removePhoto = "false";
        $(".profile-photo").src = photo;
        const removeButton = $('[data-action="remove-profile-photo"]');
        if (removeButton) removeButton.classList.remove("hidden");
        showToast("Photo ready. Save your profile to apply it.");
      };
      image.onerror = () => showToast("The selected image could not be read.", true);
      image.src = reader.result;
    };
    reader.onerror = () => showToast("The selected image could not be read.", true);
    reader.readAsDataURL(file);
  }

  document.addEventListener("click", async (event) => {
    const passwordToggle = event.target.closest("[data-password-toggle]");
    if (passwordToggle) {
      const input = document.getElementById(passwordToggle.dataset.passwordTarget);
      if (!input) return;
      const visible = input.type === "password";
      input.type = visible ? "text" : "password";
      passwordToggle.classList.toggle("is-visible", visible);
      passwordToggle.setAttribute("aria-pressed", String(visible));
      passwordToggle.setAttribute("aria-label", visible ? "Hide password" : "Show password");
      passwordToggle.title = visible ? "Hide password" : "Show password";
      return;
    }
    const authMode = event.target.closest("[data-auth-mode]");
    if (authMode) return setAuthMode(authMode.dataset.authMode);
    const pageButton = event.target.closest("[data-page]");
    if (pageButton && !event.target.closest(".sidebar-brand")) {
      event.preventDefault();
      return navigate(pageButton.dataset.page);
    }
    if (pageButton && event.target.closest(".sidebar-brand")) {
      event.preventDefault();
      return navigate(pageButton.dataset.page);
    }
    const tab = event.target.closest("[data-admin-tab]");
    if (tab) {
      $$(".tab-button").forEach((item) => item.classList.toggle("active", item === tab));
      $$(".admin-panel").forEach((panel) => panel.classList.toggle("hidden", panel.dataset.adminPanel !== tab.dataset.adminTab));
      return;
    }
    const reportTab = event.target.closest("[data-report-tab]");
    if (reportTab) {
      state.reportTab = reportTab.dataset.reportTab;
      $$(".report-tabs [data-report-tab]").forEach((item) => {
        const active = item === reportTab;
        item.classList.toggle("active", active);
        item.setAttribute("aria-pressed", String(active));
      });
      return refreshReportResults();
    }
    const action = event.target.closest("[data-action]");
    if (action) {
      if (action.disabled) return;
      action.disabled = true;
      action.classList.add("is-busy");
      action.setAttribute("aria-busy", "true");
      try {
        await handleAction(action);
      } catch (error) {
        showToast(error.message, true);
      } finally {
        if (action.isConnected) {
          action.disabled = false;
          action.classList.remove("is-busy");
          action.removeAttribute("aria-busy");
        }
      }
    }
  });

  document.addEventListener("submit", async (event) => {
    const form = event.target;
    if (!["login-form", "register-form", "record-form", "department-form", "settings-form", "profile-form", "report-filter-form"].includes(form.id)) return;
    event.preventDefault();
    const submit = form.querySelector('[type="submit"],button:not([type])');
    if (submit) { submit.disabled = true; submit.dataset.originalText = submit.textContent; submit.textContent = "Please wait…"; }
    try {
      await handleSubmit(form);
    } catch (error) {
      if (form.id === "login-form" || form.id === "register-form") showAuthMessage(error.message, true);
      else if (form.id === "record-form") showErrorDialog("Unable to save record", error.message);
      else showToast(error.message, true);
    } finally {
      if (submit && submit.isConnected) { submit.disabled = false; submit.textContent = submit.dataset.originalText || submit.textContent; }
    }
  });

  document.addEventListener("input", (event) => {
    if (event.target.matches('[data-filter]')) applyFilters();
    if (event.target.name === "units" && event.target.closest("#record-form")) {
      refreshPatientAllocationPreview(event.target.closest("#record-form"));
    }
  });
  document.addEventListener("change", (event) => {
    if (event.target.matches('[data-filter]')) applyFilters();
    if (event.target.name === "bloodGroup" && event.target.closest("#record-form")) {
      refreshPatientAllocationPreview(event.target.closest("#record-form"));
    }
    if (event.target.id === "profile-photo-input") setProfilePhoto(event.target);
    if (event.target.id === "report-period") updateReportPeriodControls();
  });
  $("#logout-button").addEventListener("click", async () => {
    try { await request("logout"); } catch (error) { showToast(error.message, true); }
    showLogin();
  });
  $("#menu-button").addEventListener("click", () => $("#sidebar").classList.toggle("is-open"));

  async function start() {
    initializeConnectionStatus();
    configureInstallExperience();
    const stopSplashRotation = rotateBackground($(".splash-slides"), 10000);
    authRotationTimer = rotateBackground($(".auth-background"), 10000);
    const splashWait = new Promise((resolve) => setTimeout(resolve, 5000));
    if (state.token) {
      try {
        const result = await Promise.all([request("session"), splashWait]).then((values) => values[0]);
        clearInterval(stopSplashRotation);
        $("#splash").classList.add("is-done");
        return showApp(result.user);
      } catch (error) {
        localStorage.removeItem("mchToken");
        sessionStorage.removeItem("mchToken");
        state.token = "";
        await splashWait;
      }
    } else {
      request("bootstrap").then((result) => {
        $("#register-hint").textContent = result.userCount === 0 ?
          "The first account is set up as the Administrator." :
          "New accounts need Administrator approval before signing in.";
      }).catch((error) => {
        $("#register-hint").textContent = error.message;
      });
      await splashWait;
    }
    clearInterval(stopSplashRotation);
    $("#splash").classList.add("is-done");
    $("#auth").classList.remove("hidden");
  }

  start();
}());

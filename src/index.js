import {
  ALL_FORMATS,
  BlobSource,
  CanvasSink,
  Input,
  UrlSource,
} from "https://cdn.jsdelivr.net/npm/mediabunny@1.58.0/+esm";

// ========== i18n ==========
// All user-facing text lives in each language's own HTML file (as
// globalThis.MESSAGES, set by a small inline <script> before this file
// loads) — this script only looks keys up, it never hardcodes text in
// any language, so it's identical across src/index.html (en),
// src/en/index.html and src/ja/index.html.
const MESSAGES = (typeof globalThis !== "undefined" && globalThis.MESSAGES) ||
  {};
function t(key, vars) {
  let s = MESSAGES[key];
  if (s === undefined) return key; // missing translation: show the key so it's easy to spot, never blank
  if (vars) {
    for (const k in vars) s = s.split(`{${k}}`).join(vars[k]);
  }
  return s;
}

// ========== Constants ==========
const VIDEO_EXTS = new Set([
  ".mp4",
  ".mov",
  ".webm",
  ".mkv",
  ".avi",
  ".m4v",
  ".wmv",
  ".flv",
  ".ts",
  ".mts",
]);
const DB_NAME = "VideoManagerDB";
const DB_STORE = "handles";
const BOOKMARK_STORE = "bookmarks";
const STAR_STORE = "stars";
const ROOT_KEY = "rootDirectory";
const THUMB_COUNT = 10;
const THUMB_GAP = 6;
const THUMB_MIN = 30;
const THUMB_MAX = 200;
const THUMB_RENDER_WIDTH = 320; // decode/capture resolution for thumbnails (both the WebCodecs path and the video-element fallback)
const MIN_CONTENT_H = 50; // px - floor for the thumbnail/content pane when dragging the splitter
const MIN_PLAYER_H = 100; // px - floor for the video player pane
const MIN_SIDEBAR_W = 50; // px - floor for the sidebar

// ========== State ==========
let rootHandle = null;
let currentHandle = null;
let pathStack = [];
let currentEntry = null; // only one video's thumbnails are shown at a time
let genToken = 0; // invalidates in-flight thumbnail generation when superseded
let currentObjectUrl = null;
let starredPaths = new Set(); // cache of starred file paths, backed by STAR_STORE
let playlistEntries = null; // non-null while browsing an opened M3U's contents instead of a local directory
let playlistName = "";
let currentPlaylistIndex = -1; // index into playlistEntries currently playing, for continuous playback; -1 = not from a playlist
let currentDirVideoEntries = []; // video files (name+handle) in the currently displayed directory, in list order
let currentDirVideoIndex = -1; // index into currentDirVideoEntries currently playing; -1 = not from directory browsing

// Same-origin apps (e.g. petapeta served from this same host:port) can
// receive the actual dragged File directly via BroadcastChannel,
// sidestepping native DataTransfer entirely — which has proven unable to
// carry a real File across tabs/globalThiss in testing here, for reasons
// that turned out to be independent of FileSystemFileHandle vs File.
// The visual drag gesture (dragstart/dragover/drop) is kept for UX
// continuity; only the payload moves out-of-band.
const dragChannel = ("BroadcastChannel" in globalThis)
  ? new BroadcastChannel("video-manager-drag")
  : null;

// ========== DOM ==========
const $ = (id) => document.getElementById(id);
const breadcrumb = $("breadcrumb");
const fileList = $("fileList");
const contentArea = $("contentArea");
const contentEmpty = $("contentEmpty");
const playerEmpty = $("playerEmpty");
const videoEl = $("videoEl");
const dropOverlay = $("dropOverlay");
const toastEl = $("toast");
const toastText = $("toastText");
const toastProgress = $("toastProgress");
const vSplitter = $("vSplitter");
const hSplitter = $("hSplitter");
const rightPane = $("rightPane");
const currentDirLabel = $("currentDirLabel");
const dirMenu = $("dirMenu");
const menuPickDir = $("menuPickDir");
const menuAddBookmark = $("menuAddBookmark");
const bookmarkListEmpty = $("bookmarkListEmpty");
const menuExportStars = $("menuExportStars");
const menuImportStars = $("menuImportStars");
const importStarsInput = $("importStarsInput");
const menuOpenPlaylist = $("menuOpenPlaylist");
const openPlaylistInput = $("openPlaylistInput");

// ========== IndexedDB ==========
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 4);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE);
      }
      if (!db.objectStoreNames.contains(BOOKMARK_STORE)) {
        db.createObjectStore(BOOKMARK_STORE, { autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STAR_STORE)) {
        db.createObjectStore(STAR_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveRootHandle(handle) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(handle, ROOT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadRootHandle() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const req = tx.objectStore(DB_STORE).get(ROOT_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function listBookmarks() {
  return openDB().then((db) =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(BOOKMARK_STORE, "readonly");
      const store = tx.objectStore(BOOKMARK_STORE);
      const results = [];
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          results.push({
            id: cursor.key,
            name: cursor.value.name,
            handle: cursor.value.handle,
          });
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      req.onerror = () => reject(req.error);
    })
  );
}

async function addBookmark(handle, name) {
  const existing = await listBookmarks();
  for (const bm of existing) {
    try {
      if (await bm.handle.isSameEntry(handle)) return false;
    } catch (_) { /* ignore comparison failure */ }
  }
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(BOOKMARK_STORE, "readwrite");
    tx.objectStore(BOOKMARK_STORE).add({ name, handle });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return true;
}

async function removeBookmark(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BOOKMARK_STORE, "readwrite");
    tx.objectStore(BOOKMARK_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ========== Stars (favorites) ==========
// Keyed by the same "path" string used for entry.path (root folder name +
// subfolders + filename), since File System Access handles can't be
// compared cheaply as plain object keys.
async function loadStarredPaths() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STAR_STORE, "readonly");
    const req = tx.objectStore(STAR_STORE).getAllKeys();
    req.onsuccess = () => resolve(new Set(req.result));
    req.onerror = () => reject(req.error);
  });
}

async function setStarred(path, starred) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STAR_STORE, "readwrite");
    if (starred) tx.objectStore(STAR_STORE).put(true, path);
    else tx.objectStore(STAR_STORE).delete(path);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function refreshSidebarStar(path, starred) {
  const btn = fileList.querySelector(
    `button[data-star-path="${CSS.escape(path)}"]`,
  );
  if (btn) btn.textContent = starred ? "★" : "☆";
}

async function toggleStar(path, btnEl) {
  const nowStarred = !starredPaths.has(path);
  if (nowStarred) starredPaths.add(path);
  else starredPaths.delete(path);
  if (btnEl) btnEl.textContent = nowStarred ? "★" : "☆";
  refreshSidebarStar(path, nowStarred);
  const headerStarBtn = $("headerStarBtn");
  if (headerStarBtn && currentEntry && currentEntry.path === path) {
    headerStarBtn.textContent = nowStarred ? "★" : "☆";
  }
  await setStarred(path, nowStarred);
}

function refreshAllStarButtons() {
  fileList.querySelectorAll("button[data-star-path]").forEach((btn) => {
    btn.textContent = starredPaths.has(btn.dataset.starPath) ? "★" : "☆";
  });
  const headerStarBtn = $("headerStarBtn");
  if (headerStarBtn && currentEntry) {
    headerStarBtn.textContent = starredPaths.has(currentEntry.path) ? "★" : "☆";
  }
}

// Stars (bookmarks) cover local paths and remote URLs alike, exported/
// imported as a plain M3U list. The remaining ambiguity — "is this M3U
// meant as bookmarks or as a browsable playlist?" — is resolved at drop/
// paste time by asking (see askHowToLoadM3U), not by restricting what
// can be starred.
function exportStarsM3U() {
  const localPaths = Array.from(starredPaths).sort((a, b) =>
    a.localeCompare(b, "ja")
  );
  const lines = ["#EXTM3U", ...localPaths];
  const blob = new Blob([lines.join("\n") + "\n"], { type: "audio/x-mpegurl" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "stars.m3u";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importStarsM3U(file) {
  const text = await file.text();
  const lines = text.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  let added = 0;
  for (const line of lines) {
    if (!starredPaths.has(line)) {
      starredPaths.add(line);
      await setStarred(line, true);
      added++;
    }
  }
  refreshAllStarButtons();
  showToast(
    added > 0
      ? t("starsImportedCount", { count: added })
      : t("starsImportedNone"),
  );
  setTimeout(hideToast, 2500);
}

// Shared by dropping/pasting a link and by clicking a URL entry in an
// opened M3U playlist: plays immediately AND kicks off thumbnail
// generation (loadVideoFromUrl), matching how a locally dropped file is
// handled — thumbnails are this tool's whole point.
function playRemoteUrl(url, opts = {}) {
  if (!opts.fromPlaylist) {
    currentPlaylistIndex = -1; // not part of playlist continuation
    currentDirVideoIndex = -1;
  }
  document.querySelectorAll(".thumb-cell.playing").forEach((c) =>
    c.classList.remove("playing")
  );
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
  videoEl.crossOrigin = "anonymous";
  videoEl.src = url;
  videoEl.style.display = "block";
  playerEmpty.style.display = "none";
  videoEl.onloadedmetadata = () => {
    videoEl.play().catch(() => {});
  };
  loadVideoFromUrl(url);
}

// ========== Permission ==========
async function ensurePermission(handle, mode = "read") {
  if (!handle) return false;
  const opts = { mode };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  // requestPermission() throws "User activation is required" if called
  // without a real user gesture (e.g. automatically on page load) — only
  // call it from within an actual click handler.
  if ((await handle.requestPermission(opts)) === "granted") return true;
  return false;
}

// queryPermission() alone never requires a user gesture, unlike
// requestPermission() — safe to call automatically on page load.
async function hasPermissionAlready(handle, mode = "read") {
  if (!handle) return false;
  try {
    return (await handle.queryPermission({ mode })) === "granted";
  } catch (_) {
    return false;
  }
}

// ========== Directory label / bookmark menu ==========
function updateDirLabel() {
  currentDirLabel.textContent = rootHandle
    ? ("📂 " + rootHandle.name)
    : ("📂 " + t("noDirectorySelected"));
  menuAddBookmark.disabled = !rootHandle;
}

async function renderBookmarkMenu() {
  dirMenu.querySelectorAll(".bookmark-row").forEach((el) => el.remove());
  const bookmarks = await listBookmarks();
  bookmarkListEmpty.style.display = bookmarks.length ? "none" : "";
  for (const bm of bookmarks) {
    const li = document.createElement("li");
    li.className = "bookmark-row d-flex align-items-center";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dropdown-item text-truncate flex-grow-1";
    btn.textContent = "📁 " + bm.name;
    btn.title = bm.name;
    btn.onclick = () => selectBookmark(bm);

    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "btn btn-sm btn-link text-danger px-2 py-0";
    rm.textContent = "×";
    rm.title = t("deleteBookmark");
    rm.onclick = async (e) => {
      e.stopPropagation();
      await removeBookmark(bm.id);
      await renderBookmarkMenu();
    };

    li.appendChild(btn);
    li.appendChild(rm);
    dirMenu.appendChild(li);
  }
}

async function useDirectoryHandle(handle) {
  const ok = await ensurePermission(handle, "read");
  if (!ok) {
    showToast(t("folderPermissionNeeded"));
    setTimeout(hideToast, 3000);
    return false;
  }
  rootHandle = handle;
  await saveRootHandle(handle);
  pathStack = [{ handle, name: handle.name }];
  currentHandle = handle;
  updateDirLabel();
  await renderFileList();
  return true;
}

async function selectBookmark(bm) {
  const ok = await ensurePermission(bm.handle);
  if (!ok) {
    showToast(t("bookmarkPermissionDenied"));
    setTimeout(hideToast, 3000);
    return;
  }
  await useDirectoryHandle(bm.handle);
}

// ========== Directory Picker ==========
async function pickDirectory() {
  try {
    const handle = await globalThis.showDirectoryPicker({ mode: "read" });
    await useDirectoryHandle(handle);
  } catch (e) {
    if (e.name !== "AbortError") {
      showToast(t("directoryPickFailed", { msg: e.message }));
      setTimeout(hideToast, 3000);
    }
  }
}

// Chrome/Edge can hand back a real FileSystemDirectoryHandle for a
// dropped folder via DataTransferItem.getAsFileSystemHandle() — but per
// spec it must be called synchronously for every item in the same tick
// as the drop handler (before any await), so we fire all the calls off
// together with .map() and only await the resulting promises afterward.
async function getDroppedDirectoryHandle(e) {
  const items = e.dataTransfer && e.dataTransfer.items;
  if (!items || !items.length) return null;
  const candidates = Array.from(items)
    .filter((item) =>
      item.kind === "file" && typeof item.getAsFileSystemHandle === "function"
    )
    .map((item) => item.getAsFileSystemHandle().catch(() => null));
  if (candidates.length === 0) return null;
  const handles = await Promise.all(candidates);
  return handles.find((h) => h && h.kind === "directory") || null;
}

async function tryRestoreDirectory() {
  try {
    const handle = await loadRootHandle();
    if (!handle) {
      renderSidebarEmpty();
      return;
    }
    // Auto-restoring on page load has no user gesture, so we can only
    // check the existing grant (queryPermission), never re-request it.
    // If it's no longer granted, show a prompt with a button — clicking
    // that button IS a user gesture, so requestPermission() works there.
    const granted = await hasPermissionAlready(handle);
    if (!granted) {
      renderNeedsPermission(handle);
      return;
    }
    rootHandle = handle;
    pathStack = [{ handle, name: handle.name }];
    currentHandle = handle;
    updateDirLabel();
    await renderFileList();
  } catch (e) {
    console.warn("Restore failed", e);
    renderSidebarEmpty();
  }
}

function renderNeedsPermission(handle) {
  renderBreadcrumb();
  fileList.innerHTML = "";
  fileList.appendChild($("tpl-needs-permission").content.cloneNode(true));
  $("needsPermissionText").innerHTML = t("permissionNeededPrompt", {
    name: escapeHtml(handle.name),
  });
  $("btnReauthorize").onclick = async () => {
    const ok = await useDirectoryHandle(handle);
    if (!ok) {
      showToast(t("permissionDenied"));
      setTimeout(hideToast, 2500);
    }
  };
  $("btnPickInstead").onclick = pickDirectory;
}

// ========== Navigation ==========
async function navigateTo(index) {
  pathStack = pathStack.slice(0, index + 1);
  currentHandle = pathStack[pathStack.length - 1].handle;
  await renderFileList();
}

async function enterFolder(handle, name) {
  pathStack.push({ handle, name });
  currentHandle = handle;
  await renderFileList();
}

function renderBreadcrumb() {
  breadcrumb.innerHTML = "";
  if (!currentHandle || pathStack.length === 0) {
    breadcrumb.innerHTML = `<li class="breadcrumb-item text-body-secondary">${
      t("noDirectorySelected")
    }</li>`;
    return;
  }
  pathStack.forEach((item, i) => {
    const li = document.createElement("li");
    if (i === pathStack.length - 1) {
      li.className = "breadcrumb-item active text-truncate";
      li.setAttribute("aria-current", "page");
      li.textContent = item.name || "Root";
    } else {
      li.className = "breadcrumb-item";
      const a = document.createElement("a");
      a.href = "#";
      a.textContent = item.name || "Root";
      a.onclick = (e) => {
        e.preventDefault();
        navigateTo(i);
      };
      li.appendChild(a);
    }
    breadcrumb.appendChild(li);
  });
}

// ========== M3U playlists (browsable, read-only) ==========
// Opening an M3U here is a distinct action from importing it as stars:
// it just lists the file's entries for browsing/playback in this
// session, without saving anything. http(s) entries play directly
// (like the Web list). A plain-path entry is meaningless on its own —
// we have no filesystem access to an arbitrary path — so we try to
// resolve it against whichever local directory is currently open, by
// walking the path the same way our own star/export paths are built
// (rootName/sub/.../file.ext).
async function resolveLocalPathToHandle(path) {
  if (!rootHandle) return null;
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2 || segments[0] !== rootHandle.name) return null;
  try {
    let dirHandle = rootHandle;
    for (let i = 1; i < segments.length - 1; i++) {
      dirHandle = await dirHandle.getDirectoryHandle(segments[i]);
    }
    return await dirHandle.getFileHandle(segments[segments.length - 1]);
  } catch (_) {
    return null;
  }
}

async function openM3UPlaylist(file) {
  const text = await file.text();
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) =>
    l && !l.startsWith("#")
  );
  if (lines.length === 0) {
    showToast(t("m3uEmpty"));
    setTimeout(hideToast, 2000);
    return;
  }
  playlistEntries = lines.map((line) => ({
    raw: line,
    isRemote: /^https?:\/\//i.test(line),
  }));
  playlistName = file.name;
  currentPlaylistIndex = -1;
  renderPlaylist();
}

function exitPlaylist() {
  playlistEntries = null;
  playlistName = "";
  currentPlaylistIndex = -1;
  if (currentHandle) {
    renderFileList();
  } else {
    renderSidebarEmpty();
  }
}

function renderPlaylist() {
  breadcrumb.innerHTML = "";
  const backLi = document.createElement("li");
  backLi.className = "breadcrumb-item";
  const backA = document.createElement("a");
  backA.href = "#";
  backA.textContent = t("directoryLabel");
  backA.onclick = (e) => {
    e.preventDefault();
    exitPlaylist();
  };
  backLi.appendChild(backA);
  const curLi = document.createElement("li");
  curLi.className = "breadcrumb-item active text-truncate";
  curLi.setAttribute("aria-current", "page");
  curLi.textContent = `📃 ${playlistName}`;
  breadcrumb.appendChild(backLi);
  breadcrumb.appendChild(curLi);

  fileList.innerHTML = "";
  const group = document.createElement("div");
  group.className = "list-group list-group-flush";
  playlistEntries.forEach((entry, idx) => {
    const isNowPlaying = idx === currentPlaylistIndex;
    const row = document.createElement("div");
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.className =
      "list-group-item list-group-item-action d-flex align-items-center gap-2 text-truncate" +
      (isNowPlaying ? " active" : "");

    const icon = document.createElement("span");
    icon.textContent = isNowPlaying ? "▶️" : (entry.isRemote ? "🌐" : "🎬");
    row.appendChild(icon);

    const label = document.createElement("span");
    label.className = "text-truncate flex-grow-1";
    label.textContent = entry.raw;
    label.title = entry.raw;
    row.appendChild(label);

    // Stars now cover both local paths and remote URLs uniformly — with
    // the Web list gone, "starred" just means "in the favorites list",
    // local or not; entry.raw (the exact M3U line) is used as the key
    // either way, so it round-trips through export/import unchanged.
    const starBtn = document.createElement("button");
    starBtn.type = "button";
    starBtn.className = "btn btn-sm p-0 border-0 bg-transparent flex-shrink-0";
    starBtn.style.fontSize = "14px";
    starBtn.style.lineHeight = "1";
    starBtn.title = t("favorite");
    starBtn.dataset.starPath = entry.raw;
    starBtn.textContent = starredPaths.has(entry.raw) ? "★" : "☆";
    starBtn.onclick = (e) => {
      e.stopPropagation();
      toggleStar(entry.raw, starBtn);
    };
    row.appendChild(starBtn);

    row.onclick = () => playPlaylistEntryAt(idx);
    group.appendChild(row);
  });
  fileList.appendChild(group);
}

// Plays playlistEntries[index] immediately (thumbnails generate in
// parallel), and is what both a manual click and the 'ended' handler
// below (continuous playback) call. An entry that can't be resolved
// (e.g. its folder isn't open) is skipped rather than stopping the
// whole playlist.
async function playPlaylistEntryAt(index) {
  if (!playlistEntries || index < 0 || index >= playlistEntries.length) {
    return;
  }
  const entry = playlistEntries[index];
  currentPlaylistIndex = index;
  currentDirVideoIndex = -1; // playing from the playlist now, not directory browsing
  if (playlistEntries) renderPlaylist(); // reflect the "now playing" row

  if (entry.isRemote) {
    playRemoteUrl(entry.raw, { fromPlaylist: true });
    return;
  }
  const fileHandle = await resolveLocalPathToHandle(entry.raw);
  if (!fileHandle) {
    showToast(t("localFileNotFoundSkip", { path: entry.raw }));
    setTimeout(hideToast, 2500);
    playPlaylistEntryAt(index + 1);
    return;
  }
  const name = entry.raw.split("/").pop();
  playLocalHandleImmediately(fileHandle, name, entry.raw);
}

function renderSidebarEmpty() {
  playlistEntries = null;
  renderBreadcrumb();
  fileList.innerHTML = "";
  fileList.appendChild($("tpl-sidebar-empty").content.cloneNode(true));

  const zone = $("sidebarDropzone");
  zone.querySelector("#btnPickDir").onclick = pickDirectory;

  zone.addEventListener("dragenter", (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.add("dragover");
  });
  zone.addEventListener("dragleave", (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove("dragover");
  });
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  });
  zone.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove("dragover");
    // Read synchronously first — see the globalThis-level drop handler's
    // comment for why (post-await dataTransfer reads can come back empty).
    const files = e.dataTransfer.files;
    const firstFile = files && files.length > 0 ? files[0] : null;
    const dirHandlePromise = getDroppedDirectoryHandle(e);

    const dirHandle = await dirHandlePromise;
    if (dirHandle) {
      await useDirectoryHandle(dirHandle);
    } else if (firstFile && isM3UFile(firstFile.name)) {
      askHowToLoadM3U(firstFile);
    } else {
      // Not a folder we could get a handle for (e.g. a single video file
      // was dropped, or the browser doesn't support
      // getAsFileSystemHandle) — fall back to the picker.
      await pickDirectory();
    }
  });
}

async function renderFileList() {
  playlistEntries = null;
  renderBreadcrumb();
  fileList.innerHTML = "";

  if (!currentHandle) {
    renderSidebarEmpty();
    return;
  }

  const entries = [];
  try {
    for await (const [name, handle] of currentHandle.entries()) {
      entries.push({ name, handle });
    }
  } catch (e) {
    fileList.innerHTML = `<div class="alert alert-danger m-3" role="alert">${
      t("readError", { msg: escapeHtml(e.message) })
    }</div>`;
    return;
  }

  entries.sort((a, b) => {
    if (a.handle.kind !== b.handle.kind) {
      return a.handle.kind === "directory" ? -1 : 1;
    }
    return a.name.localeCompare(b.name, "ja");
  });

  // Tracked for continuous playback: when a video from this listing
  // ends, we advance to the next video in this same order.
  currentDirVideoEntries = entries
    .filter((e) => e.handle.kind === "file" && isVideoFile(e.name))
    .map((e) => ({ name: e.name, handle: e.handle }));
  currentDirVideoIndex = -1;

  if (entries.length === 0) {
    fileList.innerHTML = `<div class="text-body-secondary text-center p-4">${
      t("emptyFolder")
    }</div>`;
    return;
  }

  const group = document.createElement("div");
  group.className = "list-group list-group-flush";

  for (const { name, handle } of entries) {
    const isVideo = handle.kind === "file" && isVideoFile(name);
    // A <div role="button"> instead of a <button>, so a nested star
    // <button> stays valid HTML (buttons can't nest inside buttons).
    const item = document.createElement("div");
    item.setAttribute("role", "button");
    item.tabIndex = 0;
    item.className =
      "list-group-item list-group-item-action d-flex align-items-center gap-2 text-truncate" +
      (handle.kind === "directory" ? " text-primary-emphasis" : "") +
      (handle.kind === "file" && !isVideo ? " disabled" : "");
    if (isVideo) item.dataset.videoName = name;

    const icon = document.createElement("span");
    icon.className = "item-icon";
    icon.textContent = handle.kind === "directory"
      ? "📁"
      : (isVideo ? "🎬" : "📄");
    item.appendChild(icon);

    const label = document.createElement("span");
    label.className = "text-truncate flex-grow-1";
    label.textContent = name;
    item.appendChild(label);

    if (isVideo) {
      const filePath = pathStack.map((p) => p.name).join("/") + "/" + name;
      const starBtn = document.createElement("button");
      starBtn.type = "button";
      starBtn.className =
        "btn btn-sm p-0 border-0 bg-transparent flex-shrink-0";
      starBtn.style.fontSize = "14px";
      starBtn.style.lineHeight = "1";
      starBtn.title = t("favorite");
      starBtn.dataset.starPath = filePath;
      starBtn.textContent = starredPaths.has(filePath) ? "★" : "☆";
      starBtn.onclick = (e) => {
        e.stopPropagation();
        toggleStar(filePath, starBtn);
      };
      item.appendChild(starBtn);
    }

    if (handle.kind === "directory") {
      item.onclick = () => enterFolder(handle, name);
    } else if (isVideo) {
      item.onclick = () => {
        currentPlaylistIndex = -1;
        currentDirVideoIndex = currentDirVideoEntries.findIndex((v) =>
          v.name === name
        );
        highlightCurrentDirVideo();
        loadVideoFile(handle, name);
      };
    } else {
      item.title = t("notAVideoFile");
    }

    group.appendChild(item);
  }

  fileList.appendChild(group);
}

function isVideoFile(name) {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  return VIDEO_EXTS.has(ext);
}

function isM3UFile(name) {
  return /\.m3u8?$/i.test(name);
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ========== Load Video & Generate Thumbnails ==========
// Only one video's thumbnails are shown at a time: picking a new video
// replaces the previous set instead of piling up.
async function loadVideoFile(fileHandle, name, pathOverride) {
  if (
    currentEntry && currentEntry.name === name &&
    currentEntry.handle.name === fileHandle.name
  ) {
    return; // already showing this file
  }

  // Cancel any in-flight generation for the previous entry and free its thumbs.
  genToken++;
  const myToken = genToken;
  if (currentEntry) {
    for (const t of currentEntry.thumbs) {
      if (t.url) URL.revokeObjectURL(t.url);
    }
  }

  const path = pathOverride ||
    (pathStack.map((p) => p.name).join("/") + "/" + name);
  const entry = {
    handle: fileHandle,
    name,
    path,
    duration: 0,
    width: 0,
    height: 0,
    thumbs: [],
    status: "loading",
  };
  currentEntry = entry;
  renderContent();

  showToast(t("generatingThumbnails"), 0);

  try {
    const file = await fileHandle.getFile();
    entry.file = file; // cached so drag-and-drop can attach it synchronously (see populateThumbGrid)
    const input = new Input({
      source: new BlobSource(file),
      formats: ALL_FORMATS,
    });

    const duration = await input.computeDuration();
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error(t("noVideoTrack"));

    const width = await videoTrack.getDisplayWidth();
    const height = await videoTrack.getDisplayHeight();

    if (myToken !== genToken) return; // superseded while reading metadata

    entry.duration = duration;
    entry.width = width;
    entry.height = height;

    const timestamps = Array.from(
      { length: THUMB_COUNT },
      (_, i) => duration * (i + 0.5) / THUMB_COUNT,
    );
    entry.thumbs = timestamps.map((t) => ({ time: t, url: null, blob: null }));
    renderContent();

    // canDecode() only checks the codec string, not whether the actual
    // bitstream can be decoded without error on this device/browser, so
    // WebCodecs can still throw "EncodingError: Decoding error" mid-stream.
    // We try the fast mediabunny/WebCodecs path first, and transparently
    // fall back to an HTMLVideoElement + canvas capture if it fails.
    const canDecode = await videoTrack.canDecode().catch(() => false);
    let decodedOk = false;

    if (myToken !== genToken) return;

    console.log("canDecode():", canDecode, {
      codec: videoTrack.codec,
      width,
      height,
      fileName: name,
    });

    if (canDecode) {
      // Try hardware decode first (fast), and if that specifically fails
      // with a decode error, retry once forcing software decoding before
      // giving up on the WebCodecs path entirely. A hardware/driver quirk
      // with this particular file is a plausible cause when the codec
      // itself (e.g. plain "avc"/H.264) is otherwise extremely well
      // supported — software decode is slower but far more consistent.
      for (const hwPref of ["no-preference", "prefer-software"]) {
        let index = 0; // declared outside the try so the catch below can report where it got to
        try {
          const sink = new CanvasSink(videoTrack, {
            width: THUMB_RENDER_WIDTH,
            fit: "contain",
            hardwareAcceleration: hwPref,
          });
          for await (const result of sink.canvasesAtTimestamps(timestamps)) {
            if (myToken !== genToken) return; // superseded mid-generation
            if (result) {
              const blob = await canvasToJpeg(result.canvas, 0.85);
              if (myToken !== genToken) return;
              const url = URL.createObjectURL(blob);
              entry.thumbs[index] = { time: timestamps[index], url, blob };
            }
            index++;
            toastProgress.style.width = `${index * 10}%`;
            renderThumbsOnly();
          }
          decodedOk = true;
          break;
        } catch (decodeErr) {
          if (myToken !== genToken) return;
          // decodeErr is usually a DOMException (EncodingError) whose
          // console.warn(err) rendering can be terse/unhelpful, so we
          // pull out name/message explicitly. `index` tells us whether
          // this failed on the very first requested frame (most likely:
          // the decoder failed to even get going, e.g. a bad avcC
          // description) or partway through (a specific frame/GOP issue).
          console.warn(
            `mediabunny でのデコードに失敗しました (hardwareAcceleration: ${hwPref})`,
            {
              failedAtFrameIndex: index,
              failedAtTimestamp: timestamps[index],
              totalFrames: timestamps.length,
              errorName: decodeErr && decodeErr.name,
              errorMessage: decodeErr && decodeErr.message,
              errorStack: decodeErr && decodeErr.stack,
              codec: videoTrack.codec,
              width,
              height,
              fileName: name,
            },
            decodeErr,
          );
          for (const t of entry.thumbs) {
            if (t.url) URL.revokeObjectURL(t.url);
          }
          entry.thumbs = timestamps.map((t) => ({
            time: t,
            url: null,
            blob: null,
          }));
          renderThumbsOnly();
        }
      }
    }

    if (myToken !== genToken) return;

    if (!decodedOk) {
      showToast(t("generatingThumbnailsFallback"), 0);
      await generateThumbnailsViaVideoElement(file, timestamps, entry, myToken);
    }

    if (myToken !== genToken) return;

    entry.status = "ready";
    hideToast();
    renderContent();
  } catch (err) {
    if (myToken !== genToken) return;
    console.error(err);
    entry.status = "error";
    entry.error = err.message || String(err);
    showToast(t("errorPrefix", { msg: entry.error }), 100);
    setTimeout(hideToast, 3000);
    renderContent();
  }
}

// Same idea as loadVideoFile, but for a video hosted at an http(s) URL
// instead of a local FileSystemFileHandle — uses mediabunny's UrlSource
// instead of BlobSource. This only produces thumbnails if the server
// sends permissive CORS headers (Access-Control-Allow-Origin); if it
// doesn't, the video-element fallback fails per-frame with a CORS error
// (logged) and that thumbnail stays a placeholder, but playback itself
// is unaffected since <video src="..."> doesn't need CORS to just play.
async function loadVideoFromUrl(url) {
  if (currentEntry && currentEntry.path === url) {
    return; // already showing this URL
  }

  genToken++;
  const myToken = genToken;
  if (currentEntry) {
    for (const t of currentEntry.thumbs) {
      if (t.url) URL.revokeObjectURL(t.url);
    }
  }

  const name = decodeURIComponent(url.split("/").pop().split("?")[0]) || url;
  const entry = {
    handle: null,
    isRemote: true,
    remoteUrl: url,
    name,
    path: url,
    duration: 0,
    width: 0,
    height: 0,
    thumbs: [],
    status: "loading",
  };
  currentEntry = entry;
  renderContent();

  showToast(t("generatingThumbnails"), 0);

  try {
    const input = new Input({
      source: new UrlSource(url),
      formats: ALL_FORMATS,
    });

    const duration = await input.computeDuration();
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error(t("noVideoTrack"));

    const width = await videoTrack.getDisplayWidth();
    const height = await videoTrack.getDisplayHeight();

    if (myToken !== genToken) return;

    entry.duration = duration;
    entry.width = width;
    entry.height = height;

    const timestamps = Array.from(
      { length: THUMB_COUNT },
      (_, i) => duration * (i + 0.5) / THUMB_COUNT,
    );
    entry.thumbs = timestamps.map((t) => ({ time: t, url: null, blob: null }));
    renderContent();

    const canDecode = await videoTrack.canDecode().catch(() => false);
    let decodedOk = false;

    if (myToken !== genToken) return;

    console.log("canDecode() [URL]:", canDecode, {
      codec: videoTrack.codec,
      width,
      height,
      url,
    });

    if (canDecode) {
      for (const hwPref of ["no-preference", "prefer-software"]) {
        try {
          const sink = new CanvasSink(videoTrack, {
            width: THUMB_RENDER_WIDTH,
            fit: "contain",
            hardwareAcceleration: hwPref,
          });
          let index = 0;
          for await (const result of sink.canvasesAtTimestamps(timestamps)) {
            if (myToken !== genToken) return;
            if (result) {
              const blob = await canvasToJpeg(result.canvas, 0.85);
              if (myToken !== genToken) return;
              const thumbUrl = URL.createObjectURL(blob);
              entry.thumbs[index] = {
                time: timestamps[index],
                url: thumbUrl,
                blob,
              };
            }
            index++;
            toastProgress.style.width = `${index * 10}%`;
            renderThumbsOnly();
          }
          decodedOk = true;
          break;
        } catch (decodeErr) {
          if (myToken !== genToken) return;
          console.warn(
            `mediabunny(URL)でのデコードに失敗しました (hardwareAcceleration: ${hwPref})`,
            {
              errorName: decodeErr && decodeErr.name,
              errorMessage: decodeErr && decodeErr.message,
              codec: videoTrack.codec,
              width,
              height,
              url,
            },
            decodeErr,
          );
          for (const t of entry.thumbs) {
            if (t.url) URL.revokeObjectURL(t.url);
          }
          entry.thumbs = timestamps.map((t) => ({
            time: t,
            url: null,
            blob: null,
          }));
        }
      }
    }

    if (myToken !== genToken) return;

    if (!decodedOk) {
      showToast(t("generatingThumbnailsFallbackCors"), 0);
      await generateThumbnailsFromUrlViaVideoElement(
        url,
        timestamps,
        entry,
        myToken,
      );
    }

    if (myToken !== genToken) return;

    entry.status = "ready";
    hideToast();
    renderContent();
  } catch (err) {
    if (myToken !== genToken) return;
    console.error(err);
    entry.status = "error";
    entry.error = err.message || String(err);
    showToast(t("errorPrefix", { msg: entry.error }), 100);
    setTimeout(hideToast, 3000);
    renderContent();
  }
}

// Fallback thumbnail generator using the browser's native video pipeline
// (via hidden <video> elements) instead of WebCodecs. This sidesteps
// "EncodingError: Decoding error" cases that can occur with certain
// codecs/hardware decoders even when canDecode() reports true.
//
// All THUMB_COUNT timestamps are captured in parallel (one <video>
// element per timestamp, all sharing the same Blob URL) via Promise.all,
// rather than one at a time — a single <video> element can only be at
// one currentTime anyway, so getting real concurrency means giving each
// timestamp its own element; the browser can then seek/decode them
// independently instead of us waiting on 10 sequential seek+decode round
// trips.
function generateThumbnailsViaVideoElement(file, timestamps, entry, myToken) {
  const url = URL.createObjectURL(file);
  let completed = 0;

  function captureOne(t, idx) {
    return new Promise((resolve) => {
      if (myToken !== genToken) {
        resolve();
        return;
      }

      const video = document.createElement("video");
      video.preload = "auto";
      video.muted = true;
      video.playsInline = true;
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      let settled = false;

      function finish() {
        if (settled) return;
        settled = true;
        video.removeAttribute("src");
        video.load();
        resolve();
      }

      video.onerror = () => finish();

      video.onloadedmetadata = () => {
        if (myToken !== genToken) {
          finish();
          return;
        }
        // Downscale to match the primary (WebCodecs) path's resolution
        // instead of capturing at the video's native size — otherwise a
        // 4K source would get JPEG-encoded at full resolution here,
        // which is needlessly slow and memory-hungry for a thumbnail.
        const nativeW = video.videoWidth || THUMB_RENDER_WIDTH;
        const nativeH = video.videoHeight ||
          Math.round(THUMB_RENDER_WIDTH * 9 / 16);
        canvas.width = Math.min(THUMB_RENDER_WIDTH, nativeW);
        canvas.height = Math.round(canvas.width * (nativeH / nativeW));
        const safeDuration = isFinite(video.duration) ? video.duration : t;
        video.currentTime = Math.max(0, Math.min(t, safeDuration - 0.05));
      };

      video.onseeked = async () => {
        if (myToken !== genToken) {
          finish();
          return;
        }
        try {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const blob = await canvasToJpeg(canvas, 0.85);
          if (myToken !== genToken) {
            finish();
            return;
          }
          const thumbUrl = URL.createObjectURL(blob);
          entry.thumbs[idx] = { time: t, url: thumbUrl, blob };
        } catch (_) {
          // leave this thumbnail as a placeholder on failure
        }
        completed++;
        toastProgress.style.width = `${
          Math.round((completed / timestamps.length) * 100)
        }%`;
        renderThumbsOnly();
        finish();
      };

      video.src = url;
    });
  }

  return Promise.all(timestamps.map((t, idx) => captureOne(t, idx)))
    .finally(() => URL.revokeObjectURL(url));
}

// Same as generateThumbnailsViaVideoElement, but for a remote URL: no
// Blob URL to create/revoke, and crossOrigin='anonymous' is required —
// capturing frames from a cross-origin <video> onto a <canvas> throws
// (a "tainted canvas") unless the server sends permissive CORS headers.
// Per-timestamp failures (including CORS ones) just leave that
// thumbnail as a placeholder; they don't affect playback itself.
function generateThumbnailsFromUrlViaVideoElement(
  url,
  timestamps,
  entry,
  myToken,
) {
  let completed = 0;

  function captureOne(t, idx) {
    return new Promise((resolve) => {
      if (myToken !== genToken) {
        resolve();
        return;
      }

      const video = document.createElement("video");
      video.preload = "auto";
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = "anonymous";
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      let settled = false;

      function finish() {
        if (settled) return;
        settled = true;
        video.removeAttribute("src");
        video.load();
        resolve();
      }

      video.onerror = () => finish();

      video.onloadedmetadata = () => {
        if (myToken !== genToken) {
          finish();
          return;
        }
        const nativeW = video.videoWidth || THUMB_RENDER_WIDTH;
        const nativeH = video.videoHeight ||
          Math.round(THUMB_RENDER_WIDTH * 9 / 16);
        canvas.width = Math.min(THUMB_RENDER_WIDTH, nativeW);
        canvas.height = Math.round(canvas.width * (nativeH / nativeW));
        const safeDuration = isFinite(video.duration) ? video.duration : t;
        video.currentTime = Math.max(0, Math.min(t, safeDuration - 0.05));
      };

      video.onseeked = async () => {
        if (myToken !== genToken) {
          finish();
          return;
        }
        try {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const blob = await canvasToJpeg(canvas, 0.85);
          if (myToken !== genToken) {
            finish();
            return;
          }
          const thumbUrl = URL.createObjectURL(blob);
          entry.thumbs[idx] = { time: t, url: thumbUrl, blob };
        } catch (corsErr) {
          console.warn(
            "サムネイル取得に失敗しました(CORSがこのURLで許可されていない可能性があります)",
            corsErr,
            url,
          );
        }
        completed++;
        toastProgress.style.width = `${
          Math.round((completed / timestamps.length) * 100)
        }%`;
        renderThumbsOnly();
        finish();
      };

      video.src = url;
    });
  }

  return Promise.all(timestamps.map((t, idx) => captureOne(t, idx)));
}

function canvasToJpeg(canvas, quality) {
  if (canvas instanceof HTMLCanvasElement) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error(t("jpegConversionFailed")));
        },
        "image/jpeg",
        quality,
      );
    });
  }
  if (typeof canvas.convertToBlob === "function") {
    return canvas.convertToBlob({ type: "image/jpeg", quality });
  }
  throw new Error(t("unsupportedCanvasFormat"));
}

function formatTime(seconds) {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// ========== Grid layout: fill the available box with `count` tiles ==========
// Rather than maximizing tile size directly (which tends to pick a tall,
// narrow column-of-many-rows layout whenever extra height happens to be
// available), we first estimate the column count that would let `count`
// tiles of the given aspect ratio roughly fill a containerW x containerH
// box (the standard "justified grid" sizing formula), then search a small
// neighborhood around that estimate for the layout that fills the most
// area without exceeding either dimension. This keeps the grid wide
// (using the full width) instead of stretching tall to use spare height.
function computeGridLayout(containerW, containerH, count, gap, aspect) {
  if (!isFinite(aspect) || aspect <= 0) aspect = 16 / 9;
  containerW = Math.max(0, containerW);
  containerH = Math.max(0, containerH);

  function evaluate(cols) {
    cols = Math.max(1, Math.min(count, cols));
    const rows = Math.ceil(count / cols);
    const tileWByWidth = (containerW - gap * (cols - 1)) / cols;
    const tileHByHeight = (containerH - gap * (rows - 1)) / rows;
    const tileWByHeight = tileHByHeight * aspect;
    let tileW = Math.min(tileWByWidth, tileWByHeight);
    if (tileW < THUMB_MIN) return null;
    tileW = Math.min(tileW, THUMB_MAX);
    const tileH = tileW / aspect;
    return { cols, rows, tileW, tileH, area: (tileW * cols) * (tileH * rows) };
  }

  let idealCols = Math.round(
    Math.sqrt((count * containerW) / (containerH * aspect || 1)),
  );
  if (!isFinite(idealCols) || idealCols < 1) idealCols = Math.min(count, 4);

  let best = null;
  const lo = Math.max(1, idealCols - 4);
  const hi = Math.min(count, idealCols + 4);
  for (let cols = lo; cols <= hi; cols++) {
    const candidate = evaluate(cols);
    if (candidate && (!best || candidate.area > best.area)) best = candidate;
  }

  if (!best) {
    // Nothing in the neighborhood fit at the minimum tile size; scan the
    // full range, preferring the widest (most columns / fewest rows)
    // layout that still fits, so we degrade toward "wide" rather than "tall".
    for (let cols = count; cols >= 1; cols--) {
      const candidate = evaluate(cols);
      if (candidate) {
        best = candidate;
        break;
      }
    }
  }

  if (!best) {
    const cols = Math.min(count, 3);
    const rows = Math.ceil(count / cols);
    const tileW = Math.max(THUMB_MIN, Math.min(containerW, THUMB_MAX));
    best = { cols, rows, tileW, tileH: tileW / aspect };
  }

  return best;
}

function layoutThumbGrid() {
  const grid = $("thumbGrid");
  const wrap = $("thumbGridWrap");
  if (!grid || !wrap || !currentEntry) return;
  const count = currentEntry.thumbs.length || THUMB_COUNT;
  const aspect = (currentEntry.width && currentEntry.height)
    ? currentEntry.width / currentEntry.height
    : 16 / 9;
  const layout = computeGridLayout(
    wrap.clientWidth,
    wrap.clientHeight,
    count,
    THUMB_GAP,
    aspect,
  );
  grid.style.gap = `${THUMB_GAP}px`;
  // Constrain the grid's own box to exactly `cols` tiles wide so it wraps
  // at that column count (rather than whatever fits naturally), and so a
  // partial last row gets centered within this box by justify-content.
  grid.style.width = `${
    layout.cols * layout.tileW + (layout.cols - 1) * THUMB_GAP
  }px`;
  grid.querySelectorAll(".thumb-cell").forEach((cell) => {
    cell.style.width = `${layout.tileW}px`;
    cell.style.height = `${layout.tileH}px`;
  });
}

let contentResizeObserver = null;
function ensureResizeObserver() {
  if (contentResizeObserver) return;
  contentResizeObserver = new ResizeObserver(() => layoutThumbGrid());
  contentResizeObserver.observe(contentArea);
}

// ========== Render Content ==========
function renderContent() {
  if (!currentEntry) {
    contentArea.innerHTML = "";
    contentArea.appendChild(contentEmpty);
    return;
  }

  contentArea.innerHTML = "";

  const wrap = document.createElement("div");
  wrap.className = "d-flex flex-column h-100";

  const header = document.createElement("div");
  header.className = "d-flex align-items-center gap-2 pb-2 flex-shrink-0";
  // Stars cover local paths and remote URLs alike now (see renderPlaylist).
  const leftBtnHtml =
    `<button type="button" class="btn btn-sm p-0 border-0 bg-transparent flex-shrink-0" id="headerStarBtn" title="${
      t("favorite")
    }" style="font-size:16px;line-height:1;">${
      starredPaths.has(currentEntry.path) ? "★" : "☆"
    }</button>`;
  header.innerHTML = `
        ${leftBtnHtml}
        <span class="fw-semibold text-truncate flex-grow-1" style="min-width:0;" title="${
    escapeHtml(currentEntry.path)
  }">${escapeHtml(currentEntry.name)}</span>
        <span class="badge text-bg-secondary fw-normal">${
    currentEntry.status === "ready"
      ? `${
        formatTime(currentEntry.duration)
      } · ${currentEntry.width}×${currentEntry.height}`
      : (currentEntry.status === "error"
        ? t("statusError")
        : t("statusGenerating"))
  }</span>
        <button type="button" class="btn-close" aria-label="${
    t("close")
  }"></button>
      `;
  header.querySelector("#headerStarBtn").onclick = () =>
    toggleStar(currentEntry.path, header.querySelector("#headerStarBtn"));
  header.querySelector(".btn-close").onclick = () => {
    genToken++; // cancel any in-flight generation
    for (const t of currentEntry.thumbs) {
      if (t.url) URL.revokeObjectURL(t.url);
    }
    currentEntry = null;
    renderContent();
  };
  wrap.appendChild(header);

  if (currentEntry.status === "error") {
    const alert = document.createElement("div");
    alert.className = "alert alert-danger mb-0";
    alert.textContent = currentEntry.error || t("statusError");
    wrap.appendChild(alert);
    contentArea.appendChild(wrap);
    return;
  }

  const gridWrap = document.createElement("div");
  gridWrap.id = "thumbGridWrap";
  gridWrap.className =
    "flex-grow-1 d-flex align-items-center justify-content-center";

  const grid = document.createElement("div");
  grid.id = "thumbGrid";
  gridWrap.appendChild(grid);
  wrap.appendChild(gridWrap);
  contentArea.appendChild(wrap);

  populateThumbGrid();
  layoutThumbGrid();
  ensureResizeObserver();
}

// Re-populate only the thumbnail cells (used while thumbnails stream in,
// so we don't tear down/rebuild the whole panel on every frame).
function renderThumbsOnly() {
  if (!currentEntry || !$("thumbGrid")) {
    renderContent();
    return;
  }
  populateThumbGrid();
  layoutThumbGrid();
}

function populateThumbGrid() {
  const grid = $("thumbGrid");
  if (!grid) return;
  grid.innerHTML = "";
  currentEntry.thumbs.forEach((thumb, i) => {
    const cell = document.createElement("div");
    cell.className = "thumb-cell";
    cell.draggable = true;

    if (thumb.url) {
      cell.innerHTML = `
            <img src="${thumb.url}" alt="Thumb ${i + 1}" draggable="false">
            <span class="t-label">${formatTime(thumb.time)}</span>
          `;
    } else {
      cell.innerHTML =
        `<div class="ph"><div class="spinner-border spinner-border-sm text-secondary" role="status"></div></div>`;
    }

    cell.onclick = () => playVideo(currentEntry, thumb.time, cell);

    // IMPORTANT: dataTransfer must be populated synchronously inside the
    // 'dragstart' handler. Browsers ignore setData()/items.add() calls
    // made after an `await` yields control, because the drag operation
    // has already started without that data — that's why dropping onto
    // another tab/app previously did nothing. We avoid any await here by
    // reusing the File already cached on the entry (see loadVideoFile),
    // so a real File is attached and other apps (e.g. petapeta, a
    // desktop file manager, another browser tab) can read it via
    // e.dataTransfer.files on drop.
    cell.addEventListener("dragstart", (e) => {
      if (!currentEntry) return;
      if (currentEntry.isRemote) {
        // No local File to attach — a URL is itself the thing worth
        // dragging out (e.g. into an address bar, or an app that reads
        // text/uri-list), so hand that off instead.
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData("text/uri-list", currentEntry.remoteUrl);
        e.dataTransfer.setData("text/plain", currentEntry.remoteUrl);
        e.dataTransfer.setData(
          "application/x-video-manager",
          JSON.stringify({
            name: currentEntry.name,
            time: thumb.time,
            path: currentEntry.path,
          }),
        );
        if (dragChannel) {
          dragChannel.postMessage({
            type: "drag-url",
            url: currentEntry.remoteUrl,
            time: thumb.time,
            name: currentEntry.name,
          });
        }
        return;
      }
      if (!currentEntry.file) return;
      e.dataTransfer.effectAllowed = "copy";
      e.dataTransfer.items.add(currentEntry.file);
      e.dataTransfer.setData("text/plain", currentEntry.name);
      // Custom data other pages can optionally read (e.g. if petapeta's
      // own source is extended to look for it) to know which second of
      // the video this thumbnail represents. Native file drops can't
      // convey "start playback at N seconds" on their own — only the
      // file itself is guaranteed to transfer to a third-party app.
      e.dataTransfer.setData(
        "application/x-video-manager",
        JSON.stringify({
          name: currentEntry.name,
          time: thumb.time,
          path: currentEntry.path,
        }),
      );
      // Same-origin fallback/primary channel: File is structured-clone-
      // able, so a same-origin receiver (e.g. petapeta) listening on
      // 'video-manager-drag' gets the actual file this way regardless of
      // whether the native DataTransfer route above works.
      if (dragChannel) {
        dragChannel.postMessage({
          type: "drag-file",
          file: currentEntry.file,
          time: thumb.time,
          name: currentEntry.name,
        });
      }
    });
    cell.addEventListener("dragend", () => {
      // Let same-origin listeners know the drag is over, so a later,
      // unrelated drop elsewhere doesn't reuse a stale file/time.
      if (dragChannel) dragChannel.postMessage({ type: "drag-end" });
    });

    grid.appendChild(cell);
  });
}

// ========== Player ==========
async function playVideo(entry, seekTime = 0, cellEl = null) {
  try {
    document.querySelectorAll(".thumb-cell.playing").forEach((c) =>
      c.classList.remove("playing")
    );
    if (cellEl) cellEl.classList.add("playing");

    if (entry.isRemote) {
      if (currentObjectUrl) {
        URL.revokeObjectURL(currentObjectUrl);
        currentObjectUrl = null;
      }
      videoEl.crossOrigin = "anonymous";
      videoEl.src = entry.remoteUrl;
    } else {
      const file = await entry.handle.getFile();
      if (currentObjectUrl) {
        URL.revokeObjectURL(currentObjectUrl);
      }
      currentObjectUrl = URL.createObjectURL(file);
      videoEl.crossOrigin = "";
      videoEl.src = currentObjectUrl;
    }

    videoEl.style.display = "block";
    playerEmpty.style.display = "none";

    videoEl.onloadedmetadata = () => {
      videoEl.currentTime = seekTime;
      videoEl.play().catch(() => {});
    };
  } catch (err) {
    showToast(t("playbackError", { msg: err.message }));
    setTimeout(hideToast, 2500);
  }
}

// ========== M3U load-method choice (drop/paste is ambiguous) ==========
let pendingM3UFile = null;
let m3uChoiceModalInstance = null;

function ensureM3UChoiceModal() {
  if (!m3uChoiceModalInstance) {
    m3uChoiceModalInstance = new bootstrap.Modal($("m3uChoiceModal"));
  }
  return m3uChoiceModalInstance;
}

function askHowToLoadM3U(file) {
  pendingM3UFile = file;
  $("m3uChoiceFileName").textContent = file.name;
  ensureM3UChoiceModal().show();
}

$("m3uChoicePlaylistBtn").addEventListener("click", async () => {
  const file = pendingM3UFile;
  pendingM3UFile = null;
  ensureM3UChoiceModal().hide();
  if (file) await openM3UPlaylist(file);
});
$("m3uChoiceBookmarkBtn").addEventListener("click", async () => {
  const file = pendingM3UFile;
  pendingM3UFile = null;
  ensureM3UChoiceModal().hide();
  if (file) await importStarsM3U(file);
});

// ========== Window-level Drop (video files from other tabs / OS) ==========
let dragCounter = 0;

globalThis.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragCounter++;
  if (
    e.dataTransfer.types.includes("Files") ||
    e.dataTransfer.types.includes("application/x-video-manager")
  ) {
    dropOverlay.classList.add("visible");
  }
});

globalThis.addEventListener("dragleave", (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    dropOverlay.classList.remove("visible");
  }
});

globalThis.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});

globalThis.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.classList.remove("visible");

  // Read everything we need from dataTransfer synchronously, before any
  // await — the drag data store can be invalidated shortly after the
  // handler yields, so e.dataTransfer.files/getData() can silently come
  // back empty on a second, post-await access. (This is the same rule
  // as dragstart's setData(), just on the receiving end — it's what
  // broke plain single-file drops after the directory-drop check below
  // was added with an await in front of the file check.)
  const files = e.dataTransfer.files;
  const firstFile = files && files.length > 0 ? files[0] : null;
  const uriList = (e.dataTransfer.getData("text/uri-list") ||
    e.dataTransfer.getData("text/plain") || "").trim();
  const custom = e.dataTransfer.getData("application/x-video-manager");
  // getDroppedDirectoryHandle() calls item.getAsFileSystemHandle() on
  // every item synchronously inside its own .map() before returning a
  // promise, so starting it here (still before any await) is safe even
  // though we only await its result afterward.
  const dirHandlePromise = getDroppedDirectoryHandle(e);

  // Dropping a folder anywhere in the globalThis switches the working
  // directory (not just on the initial empty-state dropzone).
  const dirHandle = await dirHandlePromise;
  if (dirHandle) {
    await useDirectoryHandle(dirHandle);
    return;
  }

  // A dropped video file: play it immediately AND generate its
  // thumbnail grid (see playDroppedFile) — the thumbnails are this
  // tool's whole point, so a drop shouldn't skip them.
  if (
    firstFile &&
    (firstFile.type.startsWith("video/") || isVideoFile(firstFile.name))
  ) {
    playDroppedFile(firstFile);
    return;
  }

  // A dropped .m3u is ambiguous (playlist to browse, or bookmarks to
  // import?) — ask instead of guessing.
  if (firstFile && isM3UFile(firstFile.name)) {
    askHowToLoadM3U(firstFile);
    return;
  }

  // A dropped link (e.g. dragged from the address bar, or a page's own
  // <a> element) — same treatment as a local file: play immediately and
  // try to generate thumbnails (works if the server allows CORS).
  if (/^https?:\/\//i.test(uriList)) {
    playRemoteUrl(uriList);
    return;
  }

  if (custom) {
    try {
      const info = JSON.parse(custom);
      if (
        currentEntry &&
        (currentEntry.name === info.name || currentEntry.path === info.path)
      ) {
        playVideo(currentEntry, info.time || 0);
        return;
      }
      showToast(t("fromAnotherTab", { name: info.name }));
      setTimeout(hideToast, 3000);
    } catch (_) { /* skip */ }
  }
});

// Immediately plays a local FileSystemFileHandle-like object from the
// start AND kicks off its thumbnail grid in parallel (loadVideoFile) —
// shared by dropped/pasted files and by continuous playlist playback.
async function playLocalHandleImmediately(fileHandle, name, pathOverride) {
  try {
    const file = await fileHandle.getFile();
    videoEl.crossOrigin = "";
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = URL.createObjectURL(file);
    videoEl.src = currentObjectUrl;
    videoEl.style.display = "block";
    playerEmpty.style.display = "none";
    videoEl.onloadedmetadata = () => {
      videoEl.play().catch(() => {});
    };
  } catch (err) {
    showToast(t("playbackError", { msg: err.message }));
    setTimeout(hideToast, 2500);
  }
  loadVideoFile(fileHandle, name, pathOverride);
}

function playDroppedFile(file) {
  currentPlaylistIndex = -1; // this isn't part of any open playlist
  currentDirVideoIndex = -1; // ...or the current directory's listing
  // This tool's whole point is the 10-thumbnail grid, so a file dropped
  // straight from outside (Explorer/Finder, another tab) gets one too,
  // not just files opened via the sidebar's directory browser. Wrap the
  // File in a minimal FileSystemFileHandle-like object so it can go
  // through the exact same generation path.
  const pseudoHandle = { name: file.name, getFile: () => file };
  playLocalHandleImmediately(pseudoHandle, file.name, `(dropped)/${file.name}`);
}

// ========== Paste (Ctrl+V): a video file or a URL, same treatment as a drop ==========
globalThis.addEventListener("paste", (e) => {
  const active = document.activeElement;
  if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
    return;
  }

  const cd = e.clipboardData;
  if (!cd) return;

  // A file copied in Explorer/Finder and pasted here.
  const files = cd.files;
  const firstFile = files && files.length > 0 ? files[0] : null;
  if (firstFile) {
    if (firstFile.type.startsWith("video/") || isVideoFile(firstFile.name)) {
      e.preventDefault();
      playDroppedFile(firstFile);
      return;
    }
    if (isM3UFile(firstFile.name)) {
      e.preventDefault();
      askHowToLoadM3U(firstFile);
      return;
    }
  }

  // A copied link/URL as plain text.
  const text = (cd.getData("text/uri-list") || cd.getData("text/plain") || "")
    .trim();
  if (/^https?:\/\//i.test(text)) {
    e.preventDefault();
    playRemoteUrl(text);
  }
});

// ========== Splitters ==========
function initSplitters() {
  let vDragging = false;
  vSplitter.addEventListener("mousedown", (e) => {
    vDragging = true;
    vSplitter.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  let hDragging = false;
  hSplitter.addEventListener("mousedown", (e) => {
    hDragging = true;
    hSplitter.classList.add("dragging");
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  globalThis.addEventListener("mousemove", (e) => {
    if (vDragging) {
      const mainRect = document.querySelector(
        ".d-flex.flex-grow-1.overflow-hidden",
      ).getBoundingClientRect();
      let w = e.clientX - mainRect.left;
      w = Math.max(MIN_SIDEBAR_W, Math.min(w, mainRect.width * 0.5));
      $("sidebar").style.width = w + "px";
    }
    if (hDragging) {
      const rightRect = rightPane.getBoundingClientRect();
      let contentH = e.clientY - rightRect.top;
      const maxContentH = rightRect.height - hSplitter.offsetHeight -
        MIN_PLAYER_H;
      contentH = Math.max(
        MIN_CONTENT_H,
        Math.min(contentH, Math.max(MIN_CONTENT_H, maxContentH)),
      );
      $("contentArea").style.height = contentH + "px";
    }
  });

  globalThis.addEventListener("mouseup", () => {
    if (vDragging || hDragging) {
      vDragging = false;
      hDragging = false;
      vSplitter.classList.remove("dragging");
      hSplitter.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
  });
}

// ========== Toast ==========
function showToast(text, progress = null) {
  toastText.textContent = text;
  toastEl.classList.add("show");
  if (progress !== null) toastProgress.style.width = progress + "%";
}
function hideToast() {
  toastEl.classList.remove("show");
  toastProgress.style.width = "0%";
}

// ========== Directory menu wiring ==========
menuPickDir.addEventListener("click", pickDirectory);
menuAddBookmark.addEventListener("click", async () => {
  if (!rootHandle) return;
  const added = await addBookmark(rootHandle, rootHandle.name);
  await renderBookmarkMenu();
  showToast(added ? t("bookmarkAdded") : t("bookmarkAlreadyExists"));
  setTimeout(hideToast, 1500);
});
menuExportStars.addEventListener("click", () => {
  if (starredPaths.size === 0) {
    showToast(t("noStars"));
    setTimeout(hideToast, 1500);
    return;
  }
  exportStarsM3U();
});
menuImportStars.addEventListener("click", () => importStarsInput.click());
importStarsInput.addEventListener("change", async () => {
  const file = importStarsInput.files[0];
  importStarsInput.value = "";
  if (!file) return;
  await importStarsM3U(file);
});
menuOpenPlaylist.addEventListener("click", () => openPlaylistInput.click());
openPlaylistInput.addEventListener("change", async () => {
  const file = openPlaylistInput.files[0];
  openPlaylistInput.value = "";
  if (!file) return;
  await openM3UPlaylist(file);
});

// ========== Continuous playback (playlist mode) ==========
// When a video that came from an opened M3U playlist finishes, advance
// to the next entry automatically — thumbnails included, since that's
// handled by playPlaylistEntryAt/playLocalHandleImmediately either way.
videoEl.addEventListener("ended", () => {
  if (playlistEntries && currentPlaylistIndex >= 0) {
    playPlaylistEntryAt(currentPlaylistIndex + 1);
    return;
  }
  if (!playlistEntries && currentDirVideoIndex >= 0) {
    playDirVideoAt(currentDirVideoIndex + 1);
  }
});

// Continuous playback while browsing a plain directory (not an opened
// M3U playlist): plays the next video in the current folder's listing,
// in the same order shown in the sidebar, thumbnails included.
function playDirVideoAt(index) {
  if (index < 0 || index >= currentDirVideoEntries.length) return;
  currentDirVideoIndex = index;
  highlightCurrentDirVideo();
  const { name, handle } = currentDirVideoEntries[index];
  playLocalHandleImmediately(handle, name);
}

// Marks whichever row matches currentDirVideoIndex as the "now playing"
// one in the currently rendered directory listing (no-ops harmlessly if
// the sidebar has since navigated elsewhere and no such row exists).
function highlightCurrentDirVideo() {
  const activeName =
    (currentDirVideoIndex >= 0 && currentDirVideoEntries[currentDirVideoIndex])
      ? currentDirVideoEntries[currentDirVideoIndex].name
      : null;
  fileList.querySelectorAll("[data-video-name]").forEach((el) => {
    const isActive = el.dataset.videoName === activeName;
    el.classList.toggle("active", isActive);
    const icon = el.querySelector(".item-icon");
    if (icon) icon.textContent = isActive ? "▶️" : "🎬";
  });
}

// ========== Dark mode & language (no translatable text here — see the
// per-language <select>/<title>/etc. in each HTML file) ==========
function toggleDarkMode() {
  const html = document.documentElement;
  const newTheme = html.getAttribute("data-bs-theme") === "dark"
    ? "light"
    : "dark";
  html.setAttribute("data-bs-theme", newTheme);
  localStorage.setItem("darkMode", newTheme);
}

function changeLang() {
  const langObj = document.getElementById("lang");
  const lang = langObj.options[langObj.selectedIndex].value;
  location.href = `/video-manager/${lang}/`;
}

const toggleDarkModeBtn = $("toggleDarkMode");
if (toggleDarkModeBtn) {
  toggleDarkModeBtn.addEventListener("click", toggleDarkMode);
}
const langSelect = $("lang");
if (langSelect) langSelect.addEventListener("change", changeLang);

// ========== Init ==========
async function init() {
  initSplitters();
  updateDirLabel();
  renderBookmarkMenu();
  try {
    starredPaths = await loadStarredPaths();
  } catch (_) {
    starredPaths = new Set();
  }

  if (!globalThis.showDirectoryPicker) {
    renderSidebarEmpty();
    menuPickDir.disabled = true;
    menuPickDir.textContent = "📁 " + t("unsupportedBrowser");
    showToast(t("fsaNotSupported"));
  } else {
    await tryRestoreDirectory();
  }
}
init();

import { getSettings, syncOriginRule } from "./lib/settings.js";

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await syncOriginRule((await getSettings()).jira_base_url);
});

chrome.runtime.onStartup.addListener(async () => {
  await syncOriginRule((await getSettings()).jira_base_url);
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === "local" && changes.settings) {
    await syncOriginRule((await getSettings()).jira_base_url);
  }
});

// Keyboard shortcuts grant activeTab, so this capture works on any site
// without asking for broad host access.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "capture-screenshot") return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    await chrome.runtime.sendMessage({ type: "captured", dataUrl });
  } catch (e) {
    chrome.runtime.sendMessage({ type: "captured", error: e.message }).catch(() => {});
  }
});

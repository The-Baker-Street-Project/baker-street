import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runCommand } from "./executor.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

async function run(args: string[], session?: string) {
  try {
    const result = await runCommand(args, { session });
    return text(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: "text" as const, text: msg }], isError: true };
  }
}

export function registerTools(server: McpServer) {
  // ── Navigation ──────────────────────────────────────────────

  server.tool(
    "browser_navigate",
    "Navigate to a URL",
    {
      url: z.string().describe("URL to navigate to"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ url, sessionId }) => run(["open", url], sessionId)
  );

  server.tool(
    "browser_go_back",
    "Go back in browser history",
    {
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ sessionId }) => run(["back"], sessionId)
  );

  server.tool(
    "browser_go_forward",
    "Go forward in browser history",
    {
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ sessionId }) => run(["forward"], sessionId)
  );

  server.tool(
    "browser_reload",
    "Reload the current page",
    {
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ sessionId }) => run(["reload"], sessionId)
  );

  // ── Interaction ─────────────────────────────────────────────

  server.tool(
    "browser_click",
    "Click an element (CSS selector, text, or @ref from snapshot)",
    {
      selector: z.string().describe("CSS selector, text, or @ref"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ selector, sessionId }) => run(["click", selector], sessionId)
  );

  server.tool(
    "browser_dblclick",
    "Double-click an element",
    {
      selector: z.string().describe("CSS selector, text, or @ref"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ selector, sessionId }) => run(["dblclick", selector], sessionId)
  );

  server.tool(
    "browser_fill",
    "Clear and fill an input field with text",
    {
      selector: z.string().describe("CSS selector or @ref for the input"),
      value: z.string().describe("Text to fill"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ selector, value, sessionId }) =>
      run(["fill", selector, value], sessionId)
  );

  server.tool(
    "browser_type",
    "Type text character by character (triggers key events)",
    {
      selector: z.string().describe("CSS selector or @ref for the input"),
      text: z.string().describe("Text to type"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ selector, text: t, sessionId }) =>
      run(["type", selector, t], sessionId)
  );

  server.tool(
    "browser_press",
    "Press a keyboard key (Enter, Tab, Escape, Control+a, etc.)",
    {
      key: z.string().describe("Key to press"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ key, sessionId }) => run(["press", key], sessionId)
  );

  server.tool(
    "browser_hover",
    "Hover over an element",
    {
      selector: z.string().describe("CSS selector or @ref"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ selector, sessionId }) => run(["hover", selector], sessionId)
  );

  server.tool(
    "browser_focus",
    "Focus an element",
    {
      selector: z.string().describe("CSS selector or @ref"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ selector, sessionId }) => run(["focus", selector], sessionId)
  );

  server.tool(
    "browser_check",
    "Check a checkbox",
    {
      selector: z.string().describe("CSS selector or @ref"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ selector, sessionId }) => run(["check", selector], sessionId)
  );

  server.tool(
    "browser_uncheck",
    "Uncheck a checkbox",
    {
      selector: z.string().describe("CSS selector or @ref"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ selector, sessionId }) => run(["uncheck", selector], sessionId)
  );

  server.tool(
    "browser_select",
    "Select an option from a dropdown",
    {
      selector: z.string().describe("CSS selector or @ref for the select element"),
      value: z.string().describe("Value or label of the option"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ selector, value, sessionId }) =>
      run(["select", selector, value], sessionId)
  );

  server.tool(
    "browser_drag",
    "Drag and drop from one element to another",
    {
      source: z.string().describe("Source selector or @ref"),
      target: z.string().describe("Target selector or @ref"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ source, target, sessionId }) =>
      run(["drag", source, target], sessionId)
  );

  // ── Scrolling ───────────────────────────────────────────────

  server.tool(
    "browser_scroll",
    "Scroll the page in a direction",
    {
      direction: z
        .enum(["up", "down", "left", "right"])
        .describe("Scroll direction"),
      amount: z.number().optional().describe("Scroll amount in pixels"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ direction, amount, sessionId }) => {
      const args = ["scroll", direction];
      if (amount !== undefined) args.push(String(amount));
      return run(args, sessionId);
    }
  );

  server.tool(
    "browser_scroll_into_view",
    "Scroll an element into view",
    {
      selector: z.string().describe("CSS selector or @ref"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ selector, sessionId }) =>
      run(["scrollintoview", selector], sessionId)
  );

  // ── Snapshot & Capture ──────────────────────────────────────

  server.tool(
    "browser_snapshot",
    "Get accessibility tree snapshot with element refs for AI interaction",
    {
      interactive: z
        .boolean()
        .optional()
        .describe("Only show interactive elements"),
      compact: z
        .boolean()
        .optional()
        .describe("Remove empty structural elements"),
      selector: z
        .string()
        .optional()
        .describe("Scope snapshot to a CSS selector"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ interactive, compact, selector, sessionId }) => {
      const args = ["snapshot"];
      if (interactive) args.push("-i");
      if (compact) args.push("-c");
      if (selector) args.push("-s", selector);
      return run(args, sessionId);
    }
  );

  server.tool(
    "browser_screenshot",
    "Take a screenshot of the page or element",
    {
      path: z.string().optional().describe("File path to save screenshot"),
      fullPage: z.boolean().optional().describe("Capture full scrollable page"),
      selector: z
        .string()
        .optional()
        .describe("CSS selector to screenshot a specific element"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ path, fullPage, selector, sessionId }) => {
      const args = ["screenshot"];
      if (path) args.push(path);
      if (fullPage) args.push("--full");
      if (selector) args.push(selector);
      return run(args, sessionId);
    }
  );

  server.tool(
    "browser_pdf",
    "Save the current page as PDF",
    {
      path: z.string().describe("File path to save the PDF"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ path, sessionId }) => run(["pdf", path], sessionId)
  );

  // ── Get Info ────────────────────────────────────────────────

  server.tool(
    "browser_get_text",
    "Get text content of an element",
    {
      selector: z.string().describe("CSS selector or @ref"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ selector, sessionId }) =>
      run(["get", "text", selector], sessionId)
  );

  server.tool(
    "browser_get_html",
    "Get inner HTML of an element",
    {
      selector: z.string().describe("CSS selector or @ref"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ selector, sessionId }) =>
      run(["get", "html", selector], sessionId)
  );

  server.tool(
    "browser_get_value",
    "Get value of an input element",
    {
      selector: z.string().describe("CSS selector or @ref"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ selector, sessionId }) =>
      run(["get", "value", selector], sessionId)
  );

  server.tool(
    "browser_get_attribute",
    "Get an attribute value from an element",
    {
      selector: z.string().describe("CSS selector or @ref"),
      attribute: z.string().describe("Attribute name"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ selector, attribute, sessionId }) =>
      run(["get", "attr", selector, attribute], sessionId)
  );

  server.tool(
    "browser_get_title",
    "Get the current page title",
    {
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ sessionId }) => run(["get", "title"], sessionId)
  );

  server.tool(
    "browser_get_url",
    "Get the current page URL",
    {
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ sessionId }) => run(["get", "url"], sessionId)
  );

  server.tool(
    "browser_get_count",
    "Count elements matching a selector",
    {
      selector: z.string().describe("CSS selector"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ selector, sessionId }) =>
      run(["get", "count", selector], sessionId)
  );

  // ── Check State ─────────────────────────────────────────────

  server.tool(
    "browser_is_visible",
    "Check if an element is visible",
    {
      selector: z.string().describe("CSS selector or @ref"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ selector, sessionId }) =>
      run(["is", "visible", selector], sessionId)
  );

  server.tool(
    "browser_is_enabled",
    "Check if an element is enabled",
    {
      selector: z.string().describe("CSS selector or @ref"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ selector, sessionId }) =>
      run(["is", "enabled", selector], sessionId)
  );

  server.tool(
    "browser_is_checked",
    "Check if a checkbox/radio is checked",
    {
      selector: z.string().describe("CSS selector or @ref"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ selector, sessionId }) =>
      run(["is", "checked", selector], sessionId)
  );

  // ── Wait ────────────────────────────────────────────────────

  server.tool(
    "browser_wait",
    "Wait for an element, text, URL pattern, or milliseconds",
    {
      target: z
        .string()
        .describe(
          "CSS selector to wait for, milliseconds (e.g. '2000'), or use options"
        ),
      text: z.string().optional().describe("Wait for this text to appear"),
      url: z.string().optional().describe("Wait for URL to match pattern"),
      load: z
        .enum(["load", "domcontentloaded", "networkidle"])
        .optional()
        .describe("Wait for load state"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ target, text: waitText, url, load, sessionId }) => {
      const args = ["wait", target];
      if (waitText) args.push("--text", waitText);
      if (url) args.push("--url", url);
      if (load) args.push("--load", load);
      return run(args, sessionId);
    }
  );

  // ── JavaScript ──────────────────────────────────────────────

  server.tool(
    "browser_evaluate",
    "Execute JavaScript in the browser context",
    {
      script: z.string().describe("JavaScript code to execute"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ script, sessionId }) => run(["eval", script], sessionId)
  );

  // ── Find Elements ───────────────────────────────────────────

  server.tool(
    "browser_find",
    "Find and interact with elements using semantic locators",
    {
      locator: z
        .enum([
          "role",
          "text",
          "label",
          "placeholder",
          "alt",
          "title",
          "testid",
        ])
        .describe("Locator type"),
      value: z.string().describe("Locator value"),
      action: z
        .enum(["click", "fill", "type", "hover", "focus", "check", "uncheck", "text"])
        .describe("Action to perform"),
      actionValue: z
        .string()
        .optional()
        .describe("Value for fill/type actions"),
      name: z
        .string()
        .optional()
        .describe("Filter by accessible name"),
      exact: z
        .boolean()
        .optional()
        .describe("Exact text match"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ locator, value, action, actionValue, name, exact, sessionId }) => {
      const args = ["find", locator, value, action];
      if (actionValue) args.push(actionValue);
      if (name) args.push("--name", name);
      if (exact) args.push("--exact");
      return run(args, sessionId);
    }
  );

  // ── Cookies ─────────────────────────────────────────────────

  server.tool(
    "browser_get_cookies",
    "Get all cookies",
    {
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ sessionId }) => run(["cookies"], sessionId)
  );

  server.tool(
    "browser_set_cookie",
    "Set a cookie",
    {
      name: z.string().describe("Cookie name"),
      value: z.string().describe("Cookie value"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ name, value, sessionId }) =>
      run(["cookies", "set", name, value], sessionId)
  );

  server.tool(
    "browser_clear_cookies",
    "Clear all cookies",
    {
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ sessionId }) => run(["cookies", "clear"], sessionId)
  );

  // ── Console & Errors ────────────────────────────────────────

  server.tool(
    "browser_console",
    "View browser console messages",
    {
      clear: z.boolean().optional().describe("Clear console after reading"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ clear, sessionId }) => {
      const args = ["console"];
      if (clear) args.push("--clear");
      return run(args, sessionId);
    }
  );

  server.tool(
    "browser_errors",
    "View page errors",
    {
      clear: z.boolean().optional().describe("Clear errors after reading"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ clear, sessionId }) => {
      const args = ["errors"];
      if (clear) args.push("--clear");
      return run(args, sessionId);
    }
  );

  // ── Network ─────────────────────────────────────────────────

  server.tool(
    "browser_network_requests",
    "View tracked network requests",
    {
      filter: z.string().optional().describe("Filter pattern for URLs"),
      clear: z.boolean().optional().describe("Clear requests after reading"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ filter, clear, sessionId }) => {
      const args = ["network", "requests"];
      if (filter) args.push("--filter", filter);
      if (clear) args.push("--clear");
      return run(args, sessionId);
    }
  );

  // ── Tabs ────────────────────────────────────────────────────

  server.tool(
    "browser_tab_list",
    "List open tabs",
    {
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ sessionId }) => run(["tab"], sessionId)
  );

  server.tool(
    "browser_tab_new",
    "Open a new tab, optionally with a URL",
    {
      url: z.string().optional().describe("URL to open in new tab"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ url, sessionId }) => {
      const args = ["tab", "new"];
      if (url) args.push(url);
      return run(args, sessionId);
    }
  );

  server.tool(
    "browser_tab_switch",
    "Switch to a tab by index",
    {
      index: z.number().describe("Tab index to switch to"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ index, sessionId }) =>
      run(["tab", String(index)], sessionId)
  );

  server.tool(
    "browser_tab_close",
    "Close a tab",
    {
      index: z.number().optional().describe("Tab index to close (current if omitted)"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ index, sessionId }) => {
      const args = ["tab", "close"];
      if (index !== undefined) args.push(String(index));
      return run(args, sessionId);
    }
  );

  // ── Browser Settings ────────────────────────────────────────

  server.tool(
    "browser_set_viewport",
    "Set the browser viewport size",
    {
      width: z.number().describe("Width in pixels"),
      height: z.number().describe("Height in pixels"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ width, height, sessionId }) =>
      run(["set", "viewport", String(width), String(height)], sessionId)
  );

  server.tool(
    "browser_set_device",
    "Emulate a device (e.g. 'iPhone 14')",
    {
      device: z.string().describe("Device name to emulate"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ device, sessionId }) =>
      run(["set", "device", device], sessionId)
  );

  server.tool(
    "browser_set_offline",
    "Toggle offline mode",
    {
      enabled: z.boolean().describe("Enable or disable offline mode"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ enabled, sessionId }) =>
      run(["set", "offline", enabled ? "on" : "off"], sessionId)
  );

  server.tool(
    "browser_set_media",
    "Emulate color scheme (dark/light)",
    {
      scheme: z.enum(["dark", "light"]).describe("Color scheme to emulate"),
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ scheme, sessionId }) =>
      run(["set", "media", scheme], sessionId)
  );

  // ── Session Management ──────────────────────────────────────

  server.tool(
    "browser_close",
    "Close the browser",
    {
      sessionId: z.string().optional().describe("Browser session ID"),
    },
    async ({ sessionId }) => run(["close"], sessionId)
  );
}

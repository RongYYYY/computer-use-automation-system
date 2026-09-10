import express, { type Express, type Request } from "express";
import type { Server } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import path from "node:path";

interface DemoMember {
  readonly id: string;
  readonly name: string;
  readonly status: "Active" | "Restricted";
  readonly savingsBalance: number;
  readonly checkingBalance: number;
}

const MEMBERS: Readonly<Record<string, DemoMember>> = {
  "10001": {
    id: "10001",
    name: "Ada Rivera",
    status: "Active",
    savingsBalance: 12_450.73,
    checkingBalance: 832.1,
  },
  "10002": {
    id: "10002",
    name: "Jordan Lee",
    status: "Restricted",
    savingsBalance: 87.14,
    checkingBalance: 1_201.55,
  },
};

export interface RunningDemoServer {
  readonly origin: string;
  readonly server: Server;
  close(): Promise<void>;
}

export function createDemoApp(): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.urlencoded({ extended: false }));

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", service: "northstar-demo" });
  });

  app.get("/", (_request, response) => response.redirect("/legacy"));

  app.get("/legacy", (request, response) => {
    const child = withQuery("/legacy/search", request);
    response.type("html").send(
      page(
        "Northstar Member Servicing",
        `<header class="masthead">
          <strong>NORTHSTAR 7.4</strong>
          <span>Member Servicing Console</span>
          <span class="environment">TRAINING DATA</span>
        </header>
        <nav><a href="${child}" target="workarea">Member search</a></nav>
        <main><iframe name="workarea" title="Member servicing work area" src="${child}"></iframe></main>`,
        shellStyles,
      ),
    );
  });

  app.get("/legacy/search", (request, response) => {
    const fault = queryValue(request, "fault");
    const interstitial =
      fault === "dialog"
        ? `<div class="interstitial" role="dialog" aria-label="System notice">
            <p><strong>System notice</strong></p>
            <p>A scheduled maintenance notice must be acknowledged.</p>
            <button type="button" onclick="this.parentElement.remove()">Continue</button>
          </div>`
        : "";

    response.type("html").send(
      page(
        "Member Search",
        `${interstitial}
        <h1>Member Search</h1>
        <p class="hint">Enter a synthetic training member number.</p>
        <form method="get" action="/legacy/member">
          <table class="form-table" summary="Member search form">
            <tr>
              <td><label for="member-number-field">Member number</label></td>
              <td><input id="member-number-field" name="member_number" autocomplete="off" /></td>
            </tr>
          </table>
          ${fault ? `<input type="hidden" name="fault" value="${escapeHtml(fault)}" />` : ""}
          <input type="submit" value="Search" />
        </form>
        <p class="training">Try 10001 or 10002. Use 99999 for a not-found outcome.</p>`,
      ),
    );
  });

  app.get("/legacy/member", async (request, response) => {
    const memberId = queryValue(request, "member_number");
    const fault = queryValue(request, "fault");

    if (fault === "slow") {
      await delay(1_400);
    }
    if (fault === "session") {
      response.type("html").send(
        page(
          "Session Expired",
          `<h1>Session expired</h1>
          <div class="error-panel">Your session is no longer valid. Sign in again before continuing.</div>`,
        ),
      );
      return;
    }
    if (fault === "permission" || memberId === "90001") {
      response.status(403).type("html").send(
        page(
          "Permission Denied",
          `<h1>Permission denied</h1>
          <div class="error-panel">Your operator role cannot view this member record.</div>`,
        ),
      );
      return;
    }

    const member = MEMBERS[memberId];
    if (!member) {
      response.type("html").send(
        page(
          "Member Not Found",
          `<h1>Search Result</h1>
          <div class="business-panel" role="status">No member found for the supplied member number.</div>
          <p><a href="${withQuery("/legacy/search", request)}">Return to search</a></p>`,
        ),
      );
      return;
    }

    response.type("html").send(
      page(
        `Member ${member.id}`,
        `<h1>Member Detail</h1>
        <table class="details" summary="Member details">
          <tr><th>Member</th><td>${escapeHtml(member.name)}</td></tr>
          <tr><th>Member number</th><td>${escapeHtml(member.id)}</td></tr>
          <tr><th>Status</th><td>${member.status}</td></tr>
        </table>
        <h2>Accounts</h2>
        <table class="accounts" summary="Member accounts">
          <tr><th>Type</th><th>Masked account</th><th>Available balance</th></tr>
          <tr>
            <td><a href="${accountUrl(member.id, "savings", fault)}">Savings</a></td>
            <td>•••• 4412</td>
            <td>${currency(member.savingsBalance)}</td>
          </tr>
          <tr>
            <td><a href="${accountUrl(member.id, "checking", fault)}">Checking</a></td>
            <td>•••• 8821</td>
            <td>${currency(member.checkingBalance)}</td>
          </tr>
        </table>`,
      ),
    );
  });

  app.get("/legacy/account", (request, response) => {
    const memberId = queryValue(request, "member_number");
    const accountType = queryValue(request, "type");
    const member = MEMBERS[memberId];
    const balance =
      accountType === "checking" ? member?.checkingBalance : member?.savingsBalance;

    if (!member || balance === undefined) {
      response.status(404).type("html").send(page("Account Not Found", "<h1>Account not found</h1>"));
      return;
    }

    const label = accountType === "checking" ? "Checking" : "Savings";
    response.type("html").send(
      page(
        `${label} Account`,
        `<h1>${label} Account</h1>
        <table class="details" summary="Account details">
          <tr><th>Owner</th><td>${escapeHtml(member.name)}</td></tr>
          <tr><th>Member number</th><td>${escapeHtml(member.id)}</td></tr>
          <tr><th>Account status</th><td>${member.status}</td></tr>
          <tr><th>Current balance</th><td data-field="account-balance">${currency(balance)}</td></tr>
        </table>
        <p><a href="/legacy/subaccount/start?member_number=${encodeURIComponent(member.id)}">Open a new sub-account</a></p>`,
      ),
    );
  });

  app.get("/legacy/subaccount/start", (request, response) => {
    const memberId = queryValue(request, "member_number");
    const member = MEMBERS[memberId];
    if (!member) {
      response.status(404).type("html").send(page("Member Not Found", "<h1>Member not found</h1>"));
      return;
    }

    response.type("html").send(
      page(
        "Sub-account Setup",
        `<h1>Open Sub-account</h1>
        <div class="warning-panel">Human identity verification is required before review.</div>
        <form method="get" action="/legacy/subaccount/review">
          <input type="hidden" name="member_number" value="${escapeHtml(member.id)}" />
          <table class="form-table" summary="Sub-account setup">
            <tr><td><label for="product-field">Product</label></td><td>
              <select id="product-field" name="product">
                <option>Holiday Savings</option>
                <option>Secondary Savings</option>
              </select>
            </td></tr>
            <tr><td><label for="verified-field">Identity verified</label></td><td>
              <input id="verified-field" name="verified" type="checkbox" value="yes" required />
            </td></tr>
          </table>
          <button type="submit">Continue to review</button>
        </form>`,
      ),
    );
  });

  app.get("/legacy/subaccount/review", (request, response) => {
    const verified = queryValue(request, "verified");
    if (verified !== "yes") {
      response.status(400).type("html").send(
        page(
          "Validation Error",
          `<h1>Validation error</h1><div class="error-panel">Identity verification is required.</div>`,
        ),
      );
      return;
    }

    response.type("html").send(
      page(
        "Review Sub-account",
        `<h1>Review New Sub-account</h1>
        <div class="warning-panel">Review only. No account has been opened.</div>
        <table class="details" summary="Sub-account review">
          <tr><th>Member number</th><td>${escapeHtml(queryValue(request, "member_number"))}</td></tr>
          <tr><th>Product</th><td>${escapeHtml(queryValue(request, "product"))}</td></tr>
        </table>`,
      ),
    );
  });

  return app;
}

export async function startDemoServer(port = 4317): Promise<RunningDemoServer> {
  const app = createDemoApp();
  const server = app.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Demo server did not bind to a TCP port");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function page(title: string, body: string, extraStyles = ""): string {
  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${escapeHtml(title)}</title>
      <style>${baseStyles}${extraStyles}</style>
    </head>
    <body>${body}</body>
  </html>`;
}

function queryValue(request: Request, key: string): string {
  const value = request.query[key];
  return typeof value === "string" ? value : "";
}

function withQuery(pathname: string, request: Request): string {
  const fault = queryValue(request, "fault");
  return fault ? `${pathname}?fault=${encodeURIComponent(fault)}` : pathname;
}

function accountUrl(memberId: string, type: string, fault: string): string {
  const query = new URLSearchParams({ member_number: memberId, type });
  if (fault) query.set("fault", fault);
  return `/legacy/account?${query.toString()}`;
}

function currency(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[
        character
      ] ?? character,
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const baseStyles = `
  :root { color-scheme: light; font-family: Arial, Helvetica, sans-serif; color: #172033; }
  body { margin: 24px; background: #f4f1e8; font-size: 15px; }
  h1 { margin-top: 0; color: #173b6c; font-size: 24px; }
  h2 { color: #173b6c; font-size: 18px; }
  table { border-collapse: collapse; background: white; }
  th, td { border: 1px solid #7f8da3; padding: 9px 12px; text-align: left; }
  th { background: #dfe7f1; }
  input, select, button { font: inherit; padding: 7px 9px; }
  input[type='submit'], button { background: #173b6c; color: white; border: 1px solid #0d284c; cursor: pointer; }
  a { color: #0b4f9c; }
  .form-table { margin-bottom: 14px; }
  .hint, .training { color: #536176; }
  .error-panel, .business-panel, .warning-panel { border: 2px solid; padding: 14px; max-width: 620px; background: white; }
  .error-panel { border-color: #9e2b25; color: #7a1d18; }
  .business-panel { border-color: #9a6b00; color: #624600; }
  .warning-panel { border-color: #9a6b00; margin-bottom: 16px; }
  .interstitial { position: fixed; inset: 18% 20%; padding: 24px; background: white; border: 4px solid #9a6b00; box-shadow: 0 8px 30px #0006; z-index: 10; }
`;

const shellStyles = `
  body { margin: 0; background: #c9d3df; }
  .masthead { display: flex; gap: 28px; align-items: center; background: #173b6c; color: white; padding: 12px 18px; }
  .environment { margin-left: auto; color: #ffe38a; }
  nav { background: #dfe7f1; border-bottom: 1px solid #7f8da3; padding: 9px 18px; }
  main { height: calc(100vh - 82px); padding: 12px; }
  iframe { width: 100%; height: 100%; border: 2px ridge #7f8da3; background: #f4f1e8; }
`;

const isDirectRun =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  const requestedPort = Number.parseInt(process.env.DEMO_PORT ?? "4317", 10);
  const running = await startDemoServer(requestedPort);
  console.log(`Northstar demo listening at ${running.origin}/legacy`);
}

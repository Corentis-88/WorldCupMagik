import test from "node:test";
import assert from "node:assert/strict";
import { extractLineupsFromPage, fetchLineupSnapshotWithDiagnostics, lineupPlayerMatches } from "../src/providers/lineup-provider.mjs";

test("public lineup parser extracts confirmed starters from match article text", () => {
  const fixture = {
    id: "mex-rsa",
    date: "2026-06-11T19:00:00.000Z",
    homeTeam: "Mexico",
    awayTeam: "South Africa"
  };
  const html = `
    <p>Mexico confirmed lineup (4-1-4-1): Jose Rangel (GK), Israel Reyes, Cesar Montes, Johan Vasquez, Jesus Gallardo, Erik Lira, Roberto Alvarado, Brian Gutierrez, Alvaro Fidalgo, Julian Quinones, Raul Jimenez.</p>
    <p>South Africa confirmed lineup (5-3-2): Ronwen Williams (GK), Nkosinathi Sibisi, Ime Okon, Mbekezeli Mbokazi, Khuliso Mudau, Aubrey Maphosa Modiba, Teboho Mokoena, Sphephelo Sithole, Jayden Adams, Iqraam Rayners, Lyle Foster.</p>
  `;

  const [record] = extractLineupsFromPage({
    html,
    fixture,
    source: { name: "SportsGambler test", url: "https://example.test/mexico-vs-south-africa" },
    now: new Date("2026-06-11T18:10:00.000Z")
  });

  assert.equal(record.status, "confirmed");
  assert.equal(record.teams.Mexico.formation, "4-1-4-1");
  assert.ok(record.teams.Mexico.starters.includes("Raul Jimenez"));
  assert.ok(record.teams["South Africa"].starters.includes("Lyle Foster"));
  assert.equal(record.teams.Mexico.starters.length, 11);
});

test("lineup fetcher records source diagnostics and confirmed lineups", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => ({
    ok: true,
    text: async () => `
      <p>Mexico confirmed lineup (4-1-4-1): Jose Rangel, Israel Reyes, Cesar Montes, Johan Vasquez, Jesus Gallardo, Erik Lira, Roberto Alvarado, Brian Gutierrez, Alvaro Fidalgo, Julian Quinones, Raul Jimenez.</p>
      <p>South Africa confirmed lineup (5-3-2): Ronwen Williams, Nkosinathi Sibisi, Ime Okon, Mbekezeli Mbokazi, Khuliso Mudau, Aubrey Maphosa Modiba, Teboho Mokoena, Sphephelo Sithole, Jayden Adams, Iqraam Rayners, Lyle Foster.</p>
    `
  });

  try {
    const result = await fetchLineupSnapshotWithDiagnostics({
      fixtures: [{
        id: "mex-rsa",
        date: "2026-06-11T19:00:00.000Z",
        homeTeam: "Mexico",
        awayTeam: "South Africa"
      }],
      providerConfig: {
        mode: "self-gather",
        sources: [{
          name: "Lineup article test",
          urlTemplate: "https://example.test/{homeSlug}-vs-{awaySlug}-{dateKey}/",
          fixtureUrlFromFixtures: true
        }]
      },
      now: new Date("2026-06-11T18:10:00.000Z")
    });

    assert.equal(result.lineups.length, 1);
    assert.equal(result.diagnostics[0].status, "ok");
    assert.equal(result.lineups[0].teams.Mexico.status, "confirmed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lineup fetcher tries alternate public page date keys", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];

  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));

    return {
      ok: true,
      text: async () => String(url).includes("2026-06-14")
        ? `
          <p>Brazil confirmed lineup (4-2-3-1): Alisson, Danilo, Marquinhos, Gabriel Magalhaes, Wendell, Bruno Guimaraes, Casemiro, Raphinha, Rodrygo, Vinicius Junior, Richarlison.</p>
          <p>Morocco confirmed lineup (4-3-3): Yassine Bounou, Achraf Hakimi, Nayef Aguerd, Romain Saiss, Noussair Mazraoui, Sofyan Amrabat, Azzedine Ounahi, Bilal El Khannouss, Hakim Ziyech, Youssef En-Nesyri, Sofiane Boufal.</p>
        `
        : "<html><body>No football lineup block here.</body></html>"
    };
  };

  try {
    const result = await fetchLineupSnapshotWithDiagnostics({
      fixtures: [{
        id: "bra-mar",
        date: "2026-06-13T22:00:00.000Z",
        homeTeam: "Brazil",
        awayTeam: "Morocco"
      }],
      providerConfig: {
        mode: "self-gather",
        sources: [{
          name: "Lineup article test",
          urlTemplate: "https://example.test/{homeSlug}-vs-{awaySlug}-{dateKey}/"
        }]
      },
      now: new Date("2026-06-13T21:15:00.000Z")
    });

    assert.equal(result.lineups.length, 1);
    assert.equal(requestedUrls[0].includes("2026-06-13"), true);
    assert.equal(requestedUrls[1].includes("2026-06-14"), true);
    assert.equal(result.diagnostics.at(-1).status, "ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public lineup parser accepts common starting XI and team-sheet wording", () => {
  const fixture = {
    id: "qat-sui",
    date: "2026-06-13T19:00:00.000Z",
    homeTeam: "Qatar",
    awayTeam: "Switzerland"
  };
  const html = `
    <h2>Official team sheets</h2>
    <p>Qatar: Mahmud Abunada, Ayoub Al Oui, Pedro Miguel, Boualem Khoukhi, Homam Elamin, Issa Laye, Ahmed Fathi, Jassem Gaber, Edmilson Junior, Almoez Ali, Akram Afif.</p>
    <p>Switzerland starting XI: Gregor Kobel, Silvan Widmer, Nico Elvedi, Manuel Akanji, Ricardo Rodriguez, Remo Freuler, Granit Xhaka, Dan Ndoye, Fabian Rieder, Ruben Vargas, Breel Embolo.</p>
  `;

  const [record] = extractLineupsFromPage({
    html,
    fixture,
    source: { name: "Team-sheet wording test", url: "https://example.test/qatar-switzerland-lineups" },
    now: new Date("2026-06-13T18:40:00.000Z")
  });

  assert.equal(record.status, "confirmed");
  assert.equal(record.teams.Qatar.starters.at(-1), "Akram Afif");
  assert.ok(record.teams.Switzerland.starters.includes("Breel Embolo"));
});

test("public lineup parser keeps expected lineups as predicted", () => {
  const fixture = {
    id: "qat-sui",
    date: "2026-06-13T19:00:00.000Z",
    homeTeam: "Qatar",
    awayTeam: "Switzerland"
  };
  const html = `
    <p>Qatar expected lineup: Mahmud Abunada, Ayoub Al Oui, Pedro Miguel, Boualem Khoukhi, Homam Elamin, Issa Laye, Ahmed Fathi, Jassem Gaber, Edmilson Junior, Almoez Ali, Akram Afif.</p>
    <p>Switzerland predicted XI: Gregor Kobel, Silvan Widmer, Nico Elvedi, Manuel Akanji, Ricardo Rodriguez, Remo Freuler, Granit Xhaka, Dan Ndoye, Fabian Rieder, Ruben Vargas, Breel Embolo.</p>
  `;

  const [record] = extractLineupsFromPage({
    html,
    fixture,
    source: { name: "Expected XI wording test", url: "https://example.test/qatar-switzerland-predicted-lineups" },
    now: new Date("2026-06-13T17:40:00.000Z")
  });

  assert.equal(record.status, "predicted");
  assert.equal(record.teams.Qatar.status, "predicted");
  assert.equal(record.teams.Switzerland.status, "predicted");
});

test("lineup fetcher can follow public search result pages for confirmed sheets", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];

  globalThis.fetch = async (url) => {
    const textUrl = String(url);
    requestedUrls.push(textUrl);

    if (textUrl.includes("duckduckgo.com")) {
      return {
        ok: true,
        text: async () => `
          <a class="result__a" href="/l/?uddg=${encodeURIComponent("https://example.test/qatar-switzerland-team-sheets")}">Qatar Switzerland team sheets</a>
        `
      };
    }

    return {
      ok: true,
      text: async () => `
        <h1>Qatar v Switzerland confirmed lineups</h1>
        <p>Qatar XI: Mahmud Abunada, Ayoub Al Oui, Pedro Miguel, Boualem Khoukhi, Homam Elamin, Issa Laye, Ahmed Fathi, Jassem Gaber, Edmilson Junior, Almoez Ali, Akram Afif.</p>
        <p>Switzerland XI: Gregor Kobel, Silvan Widmer, Nico Elvedi, Manuel Akanji, Ricardo Rodriguez, Remo Freuler, Granit Xhaka, Dan Ndoye, Fabian Rieder, Ruben Vargas, Breel Embolo.</p>
      `
    };
  };

  try {
    const result = await fetchLineupSnapshotWithDiagnostics({
      fixtures: [{
        id: "qat-sui",
        date: "2026-06-13T19:00:00.000Z",
        homeTeam: "Qatar",
        awayTeam: "Switzerland"
      }],
      providerConfig: {
        mode: "self-gather",
        sources: [{
          name: "Search test",
          type: "search",
          urlTemplate: "https://duckduckgo.com/html/?q={query}",
          queries: ["{homeTeam} {awayTeam} team sheets"],
          maxResultPages: 3
        }]
      },
      now: new Date("2026-06-13T18:40:00.000Z")
    });

    assert.equal(result.lineups.length, 1);
    assert.equal(result.lineups[0].status, "confirmed");
    assert.equal(result.lineups[0].teams.Qatar.starters.includes("Akram Afif"), true);
    assert.equal(requestedUrls.some((url) => url.includes("qatar-switzerland-team-sheets")), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lineup player matcher connects full-name and surname variants", () => {
  assert.equal(lineupPlayerMatches("Raul Jimenez", "Jimenez"), true);
  assert.equal(lineupPlayerMatches("Oswin Appollis", "Appollis"), true);
  assert.equal(lineupPlayerMatches("Lyle Foster", "Alvaro Fidalgo"), false);
});

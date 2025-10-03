import { NextResponse } from 'next/server';

function toISODate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function normalizeDateISO(maybe: string | undefined): string | undefined {
  if (!maybe) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(maybe)) return maybe;
  const date = new Date(maybe);
  if (!isNaN(date.getTime())) return toISODate(date);
  return undefined;
}

function sanitizeLocationString(input?: string): string | undefined {
  if (!input) return undefined;
  let s = String(input).trim();
  // Remove any date fragment like "10 octobre 2025" with or without leading "le"
  s = s.replace(/(?:\ble\s*)?\d{1,2}\s*[a-zA-Zéèêëàâôûùîïç]+(?:\s*\d{4})?/gi, '').trim();
  // Prefer capture after "à " if present
  const m = s.match(/(?:\bà|\ba)\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]+)/i);
  if (m) s = m[1].trim();
  // Remove common leading activity words if mistakenly included
  s = s.replace(/^\s*(vacances|rando|plage|mariage|sport)\s+/i, '').trim();
  // Remove standalone years
  s = s.replace(/\b20\d{2}\b/g, ' ').trim();
  // Collapse spaces and remove trailing commas
  s = s.replace(/\s{2,}/g, ' ').replace(/[,.]$/g, '').trim();
  return s || undefined;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as any;
    const query: string | undefined = body?.query;
    if (!query || typeof query !== 'string' || !query.trim()) {
      return NextResponse.json({ error: 'Missing query' }, { status: 400 });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'Missing OPENROUTER_API_KEY' }, { status: 500 });
    }
    const model = process.env.OPENROUTER_MODEL || 'openrouter/auto';

    const payload: any = {
      model,
      messages: [
        {
          role: 'system',
          content:
            'Extrait STRICTEMENT en JSON minifié les TROIS champs suivants avec ces clés EXACTES: {"location":"<nom_du_lieu_sans_préposition>","dateISO":"YYYY-MM-DD","activity":"<activité_ou_null>"}.\nRègles: 1) location doit être uniquement le nom du lieu (ex: "Paris"), sans mots comme "à", "le", "vacances", ni date. 2) dateISO doit être au format YYYY-MM-DD (mois français acceptés, utiliser l\'année courante si absente). 3) activity doit refléter l\'activité détectée (ex: "vacances"), sinon null. 4) Réponds UNIQUEMENT par un objet JSON, sans texte additionnel.'
        },
        {
          role: 'user',
          content: `Texte: ${query}\nDate actuelle: ${toISODate(new Date())}`
        }
      ],
      temperature: 0,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'extraction_fr',
          schema: {
            type: 'object',
            properties: {
              location: { type: 'string', description: 'Nom du lieu sans préposition (ex: Paris)' },
              dateISO: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Date au format YYYY-MM-DD' },
              activity: { type: ['string', 'null'], description: 'Activité détectée (ex: vacances) ou null' }
            },
            required: ['location', 'dateISO', 'activity'],
            additionalProperties: false
          }
        }
      }
    };

    console.log('[Parse API] Envoi requête OpenRouter', { model });
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-Title': process.env.OPENROUTER_APP_TITLE || 'my-weather-app',
        'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'http://localhost:3000'
      },
      body: JSON.stringify(payload)
    });
    if (!resp.ok) {
      const text = await resp.text();
      console.log('[Parse API] Échec OpenRouter', { status: resp.status, text });
      return NextResponse.json({ error: 'OpenRouter failed', status: resp.status, text }, { status: 502 });
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    console.log('[Parse API] Contenu renvoyé (brut)', { content });
    if (typeof content !== 'string') {
      return NextResponse.json({ error: 'Model did not return content', data }, { status: 502 });
    }

    let obj: any;
    try {
      obj = JSON.parse(content);
    } catch (e: any) {
      console.log('[Parse API] JSON.parse échec', { message: e?.message });
      return NextResponse.json({ error: 'Model content is not valid JSON', content }, { status: 502 });
    }

    // Accept common synonyms just in case
    const rawLocation =
      (typeof obj.location === 'string' && obj.location) ||
      (typeof obj.lieu === 'string' && obj.lieu) ||
      (typeof obj.ville === 'string' && obj.ville) || undefined;
    const rawDate =
      (typeof obj.dateISO === 'string' && obj.dateISO) ||
      (typeof obj.date === 'string' && obj.date) || undefined;
    const rawActivity =
      (typeof obj.activity === 'string' || obj.activity === null) ? obj.activity : undefined;

    const normalized = {
      location: sanitizeLocationString(rawLocation) ?? null,
      dateISO: normalizeDateISO(rawDate) ?? null,
      activity: rawActivity ?? null,
    };

    console.log('[Parse API] Champs normalisés', normalized);

    return NextResponse.json({
      model_content: content,
      model_parsed: {
        location: rawLocation ?? null,
        dateISO: rawDate ?? null,
        activity: rawActivity ?? null,
      },
      normalized,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Internal error' }, { status: 500 });
  }
}

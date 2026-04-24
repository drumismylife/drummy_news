/**
 * Cloudflare Worker — Naver News + Claude 요약 프록시
 *
 * 환경변수 4개 설정 필요:
 * - ANTHROPIC_API_KEY   : sk-ant-...
 * - APP_PASSWORD        : 앱 비밀번호
 * - NAVER_CLIENT_ID     : 네이버 개발자센터 Client ID
 * - NAVER_CLIENT_SECRET : 네이버 개발자센터 Client Secret
 */

const ALLOWED_ORIGIN = "https://drumismylife.github.io";

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return cors(null, 204, env);
    if (request.method !== "POST")    return cors(json({ error: "Method not allowed" }), 405, env);

    if (!env.ANTHROPIC_API_KEY || !env.APP_PASSWORD || !env.NAVER_CLIENT_ID || !env.NAVER_CLIENT_SECRET) {
      return cors(json({ error: "Server misconfigured" }), 500, env);
    }

    let body;
    try { body = await request.json(); }
    catch { return cors(json({ error: "Invalid JSON" }), 400, env); }

    if (body._pw !== env.APP_PASSWORD) {
      return cors(json({ error: "Unauthorized" }), 401, env);
    }

    const keyword = (body.keyword || '').trim();
    if (!keyword) return cors(json({ error: "keyword required" }), 400, env);

    // ── 1. 네이버 뉴스 검색 ──
    let articles;
    try {
      const naverRes = await fetch(
        `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(keyword)}&display=20&sort=date`,
        {
          headers: {
            'X-Naver-Client-Id':     env.NAVER_CLIENT_ID,
            'X-Naver-Client-Secret': env.NAVER_CLIENT_SECRET,
          },
        }
      );
      if (!naverRes.ok) throw new Error(`Naver API ${naverRes.status}`);
      const naverData = await naverRes.json();
      articles = (naverData.items || []).map(item => ({
        title:       item.title.replace(/<[^>]+>/g, ''),
        description: item.description.replace(/<[^>]+>/g, ''),
        link:        item.originallink || item.link,
        pubDate:     item.pubDate,
      }));
    } catch (err) {
      return cors(json({ error: "뉴스 검색 실패", detail: err.message }), 502, env);
    }

    if (articles.length === 0) {
      return cors(json({ error: "검색 결과가 없습니다." }), 404, env);
    }

    // ── 2. Claude: 요약·카테고리·감성만 요청 (최소 출력) ──
    const articleList = articles.map((a, i) =>
      `[${i}] ${a.title} / ${a.description}`
    ).join('\n');

    const prompt = `아래 뉴스 기사 각각에 대해 JSON 배열만 출력하세요 (다른 텍스트 없이):
[{"i":0,"summary":"한 문장 요약","category":"Politics|Economy|Technology|Science|Society|Culture|Sports|Health|Environment","sentiment":"positive|neutral|negative"}]

${articleList}`;

    let claudeItems;
    try {
      const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type":      "application/json",
          "x-api-key":         env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model:      "claude-haiku-4-5-20251001",
          max_tokens: 4000,
          messages:   [{ role: "user", content: prompt }],
        }),
      });

      const claudeData = await claudeRes.json();
      if (claudeData.error) throw new Error(claudeData.error.message);

      const text  = (claudeData.content || []).filter(b => b.type === 'text').pop()?.text || '';
      const start = text.indexOf('[');
      const end   = text.lastIndexOf(']');
      claudeItems = JSON.parse(text.slice(start, end + 1));

    } catch (err) {
      return cors(json({ error: "Claude API 오류", detail: err.message }), 500, env);
    }

    // ── 3. Worker에서 최종 JSON 조립 ──
    const result = articles.map((a, i) => {
      const c = claudeItems.find(x => x.i === i) || {};
      const domain = (() => { try { return new URL(a.link).hostname.replace('www.', ''); } catch { return a.link; } })();
      const date   = new Date(a.pubDate).toLocaleDateString('ko-KR', { year:'numeric', month:'short', day:'numeric' });
      return {
        title:     a.title,
        source:    domain,
        country:   'Korea',
        date,
        summary:   c.summary  || a.description,
        category:  c.category || 'Society',
        url:       a.link,
        sentiment: c.sentiment || 'neutral',
      };
    });

    return cors(json({ articles: result }), 200, env);
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function cors(response, status, env) {
  const headers = new Headers(response ? response.headers : {});
  headers.set("Access-Control-Allow-Origin",  ALLOWED_ORIGIN);
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(response ? response.body : null, { status, headers });
}

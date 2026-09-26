/**
 * Cloudflare Worker: テクニカルシート評価システム API
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;

    // CORS プリフライト対応
    if (method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json; charset=UTF-8",
    };

    try {
      // 1. ヘルスチェック
      if (url.pathname === "/api/health") {
        return new Response(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }), {
          headers: corsHeaders,
        });
      }

      // 2. ブートストラップ同期（全フロアスタッフ、アドバイザー、評価データの一括取得）
      if (url.pathname === "/api/bootstrap" && method === "GET") {
        const staffRes = await env.DB.prepare("SELECT * FROM staff ORDER BY floor, order_num, name").all();
        const advisorsRes = await env.DB.prepare("SELECT * FROM advisors").all();
        const evalsRes = await env.DB.prepare("SELECT * FROM evaluations").all();

        return new Response(
          JSON.stringify({
            success: true,
            staff: staffRes.results || [],
            advisors: advisorsRes.results || [],
            evaluations: evalsRes.results || [],
            serverTime: new Date().toISOString(),
          }),
          { headers: corsHeaders }
        );
      }

      // 3. スタッフマスター API
      if (url.pathname === "/api/staff") {
        if (method === "GET") {
          const res = await env.DB.prepare("SELECT * FROM staff ORDER BY floor, order_num, name").all();
          return new Response(JSON.stringify({ success: true, staff: res.results || [] }), { headers: corsHeaders });
        }
        if (method === "POST") {
          const body = await request.json();
          const now = new Date().toISOString();
          const { id, floor, name, role = "general", order_num = 0 } = body;

          if (!id || !floor || !name) {
            return new Response(JSON.stringify({ success: false, error: "必須項目が不足しています" }), {
              status: 400,
              headers: corsHeaders,
            });
          }

          await env.DB.prepare(
            `INSERT INTO staff (id, floor, name, role, order_num, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               floor = excluded.floor,
               name = excluded.name,
               role = excluded.role,
               order_num = excluded.order_num,
               updated_at = excluded.updated_at`
          )
            .bind(id, floor, name, role, order_num, now, now)
            .run();

          return new Response(JSON.stringify({ success: true, message: "スタッフを保存しました" }), {
            headers: corsHeaders,
          });
        }
      }

      // スタッフ削除
      if (url.pathname.startsWith("/api/staff/") && method === "DELETE") {
        const staffId = decodeURIComponent(url.pathname.replace("/api/staff/", ""));
        await env.DB.prepare("DELETE FROM staff WHERE id = ?").bind(staffId).run();
        await env.DB.prepare("DELETE FROM evaluations WHERE staff_id = ?").bind(staffId).run();
        return new Response(JSON.stringify({ success: true, message: "削除しました" }), { headers: corsHeaders });
      }

      // 4. アドバイザー設定 API
      if (url.pathname === "/api/advisors") {
        if (method === "GET") {
          const res = await env.DB.prepare("SELECT * FROM advisors").all();
          return new Response(JSON.stringify({ success: true, advisors: res.results || [] }), { headers: corsHeaders });
        }
        if (method === "POST") {
          const body = await request.json();
          const now = new Date().toISOString();
          const { floor, advisor_name } = body;

          await env.DB.prepare(
            `INSERT INTO advisors (floor, advisor_name, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(floor) DO UPDATE SET
               advisor_name = excluded.advisor_name,
               updated_at = excluded.updated_at`
          )
            .bind(floor, advisor_name, now)
            .run();

          return new Response(JSON.stringify({ success: true, message: "アドバイザー名を更新しました" }), {
            headers: corsHeaders,
          });
        }
      }

      // 5. 評価データ即時同期 API（単一または複数件の一括更新）
      if (url.pathname === "/api/evaluations/sync" && method === "POST") {
        const body = await request.json();
        const items = Array.isArray(body.items) ? body.items : [body];
        const now = new Date().toISOString();

        const stmts = items.map((item) => {
          const {
            staff_id,
            item_id,
            check_eval = "",
            score = "",
            checks_json = "[]",
            memo = "",
            evaluator_name = "",
            evaluation_date = "",
            updated_at = now,
          } = item;

          return env.DB.prepare(
            `INSERT INTO evaluations (staff_id, item_id, check_eval, score, checks_json, memo, evaluator_name, evaluation_date, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(staff_id, item_id) DO UPDATE SET
               check_eval = excluded.check_eval,
               score = excluded.score,
               checks_json = excluded.checks_json,
               memo = excluded.memo,
               evaluator_name = excluded.evaluator_name,
               evaluation_date = excluded.evaluation_date,
               updated_at = excluded.updated_at
             WHERE excluded.updated_at >= evaluations.updated_at`
          ).bind(
            staff_id,
            item_id,
            check_eval || "",
            score || "",
            typeof checks_json === "string" ? checks_json : JSON.stringify(checks_json || []),
            memo || "",
            evaluator_name || "",
            evaluation_date || "",
            updated_at
          );
        });

        if (stmts.length > 0) {
          await env.DB.batch(stmts);
        }

        return new Response(JSON.stringify({ success: true, count: stmts.length, serverTime: now }), {
          headers: corsHeaders,
        });
      }

      // API ルートに一致しない場合は静的アセットを配信
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error("Worker error:", err);
      return new Response(JSON.stringify({ success: false, error: err.message }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  },
};

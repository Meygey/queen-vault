import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WA_TOKEN = Deno.env.get("WA_TOKEN")!;
const WA_PHONE_NUMBER_ID = Deno.env.get("WA_PHONE_NUMBER_ID")!;
const VERIFY_TOKEN = Deno.env.get("VERIFY_TOKEN")!;
const ADMIN_PHONE = Deno.env.get("ADMIN_PHONE") || "584166978426";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function enviarWhatsApp(to: string, text: string) {
  const res = await fetch(
    `https://graph.facebook.com/v21.0/${WA_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${WA_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      }),
    }
  );
  if (!res.ok) {
    const errTxt = await res.text();
    throw new Error(`Error enviando WhatsApp: ${errTxt}`);
  }
}

async function manejarInsertParticipante(record: any) {
  const mods = Array.isArray(record.modalidades)
    ? record.modalidades.join(", ")
    : record.modalidades || "No especificadas";

  const mensaje =
    `Nueva postulacion recibida\n` +
    `ID: ${record.id}\n` +
    `Alias: ${record.alias_artistico || "-"}\n` +
    `Pais: ${record.pais || "-"}\n` +
    `WhatsApp: ${record.whatsapp_contacto || "-"}\n` +
    `Modalidades: ${mods}\n` +
    `Foto: ${record.foto_url || "-"}\n\n` +
    `Responde con:\n` +
    `APROBAR ${record.id}\n` +
    `o\n` +
    `RECHAZAR ${record.id}`;

  await enviarWhatsApp(ADMIN_PHONE, mensaje);
}

async function manejarRespuestaAdmin(from: string, bodyText: string) {
  const limpio = (from || "").replace(/[^0-9]/g, "");
  if (limpio !== ADMIN_PHONE) return;

  const match = (bodyText || "").trim().match(/^(APROBAR|RECHAZAR)\s+(\d+)$/i);
  if (!match) return;

  const accion = match[1].toUpperCase();
  const id = Number(match[2]);

  const { data: post, error: selErr } = await supabase
    .from("participantes")
    .select("*")
    .eq("id", id)
    .single();

  if (selErr || !post) {
    await enviarWhatsApp(ADMIN_PHONE, `No se encontro la postulacion ID ${id}.`);
    return;
  }

  if (accion === "APROBAR") {
    const { error: updErr } = await supabase
      .from("participantes")
      .update({
        estado_postulacion: "Aprobada",
        publicada_en_catalogo: true,
      })
      .eq("id", id);

    if (updErr) {
      await enviarWhatsApp(ADMIN_PHONE, `Error al aprobar ID ${id}: ${updErr.message}`);
      return;
    }

    const { error: insErr } = await supabase.from("creadoras").insert([
      {
        codigo: post.codigo_perfil || `QV-${id}`,
        alias: post.alias_artistico,
        pais: post.pais,
        descripcion: "Perfil activo en Queen Vault.",
        modalidades: Array.isArray(post.modalidades) ? post.modalidades : [],
        foto_url: post.foto_url,
        activa: true,
      },
    ]);

    if (insErr) {
      await enviarWhatsApp(
        ADMIN_PHONE,
        `Postulacion ID ${id} aprobada, pero revisa la insercion en creadoras: ${insErr.message}`
      );
      return;
    }

    await enviarWhatsApp(ADMIN_PHONE, `Postulacion ID ${id} (${post.alias_artistico}) aprobada y publicada en el catalogo.`);
  } else {
    const { error: rejErr } = await supabase
      .from("participantes")
      .update({
        estado_postulacion: "Rechazada",
        publicada_en_catalogo: false,
      })
      .eq("id", id);

    if (rejErr) {
      await enviarWhatsApp(ADMIN_PHONE, `Error al rechazar ID ${id}: ${rejErr.message}`);
      return;
    }

    await enviarWhatsApp(ADMIN_PHONE, `Postulacion ID ${id} (${post.alias_artistico}) marcada como rechazada.`);
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token === VERIFY_TOKEN && challenge) {
      return new Response(challenge, { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  if (req.method === "POST") {
    try {
      const payload = await req.json();

      if (payload?.type === "INSERT" && payload?.table === "participantes" && payload?.record) {
        await manejarInsertParticipante(payload.record);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      const entry = payload?.entry?.[0];
      const change = entry?.changes?.[0];
      const msg = change?.value?.messages?.[0];
      if (msg && msg.type === "text") {
        await manejarRespuestaAdmin(msg.from, msg.text?.body || "");
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err: any) {
      return new Response(JSON.stringify({ error: err?.message || "Error interno" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  return new Response("Method not allowed", { status: 405 });
});

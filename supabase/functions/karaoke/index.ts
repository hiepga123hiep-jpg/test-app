import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN') || '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Chỉ hỗ trợ POST.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const replicateToken = Deno.env.get('REPLICATE_API_TOKEN');
  const modelVersion = Deno.env.get('REPLICATE_DEMUCS_VERSION');
  if (!supabaseUrl || !anonKey || !serviceRoleKey || !replicateToken || !modelVersion) {
    return json({ error: 'Dịch vụ karaoke chưa được cấu hình đầy đủ.' }, 503);
  }

  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return json({ error: 'Cần đăng nhập để dùng karaoke.' }, 401);
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) return json({ error: 'Phiên đăng nhập không hợp lệ. Hãy đăng nhập lại.' }, 401);

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let temporaryObjectPath: string | null = null;
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json({ error: 'Nội dung yêu cầu karaoke không hợp lệ.' }, 400);
    }
    const payload = body as Record<string, unknown>;

    if (payload.action === 'status') {
      const jobId = typeof payload.jobId === 'string' ? payload.jobId : '';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) {
        return json({ error: 'Mã tác vụ karaoke không hợp lệ.' }, 400);
      }
      const { data: job, error: jobError } = await admin
        .from('karaoke_jobs')
        .select('id, prediction_id')
        .eq('id', jobId)
        .eq('user_id', user.id)
        .maybeSingle();
      if (jobError) throw jobError;
      if (!job) return json({ error: 'Không tìm thấy tác vụ karaoke của tài khoản này.' }, 404);
      const predictionResponse = await fetch(`https://api.replicate.com/v1/predictions/${encodeURIComponent(job.prediction_id)}`, {
        headers: { Authorization: `Bearer ${replicateToken}` },
      });
      const prediction = await predictionResponse.json();
      if (!predictionResponse.ok) throw new Error(prediction.detail || prediction.error || 'Không thể kiểm tra tiến trình tách nhạc.');
      if (prediction.status === 'failed' || prediction.status === 'canceled') {
        return json({ status: prediction.status, error: prediction.error || 'Model không thể tách bài hát.' });
      }
      if (prediction.status !== 'succeeded') return json({ status: prediction.status });
      const stems = getStemUrls(prediction.output);
      if (!stems) return json({ error: 'Model đã chạy nhưng không trả về vocal và instrumental tương thích.' }, 502);
      return json({ status: prediction.status, ...stems });
    }

    const objectPath = typeof payload.objectPath === 'string' ? payload.objectPath : '';
    const validObjectPath = new RegExp(`^${user.id}/[0-9a-f-]{36}(?:\\.(?:mp3|wav|m4a|flac|ogg|aac))?$`, 'i');
    if (!validObjectPath.test(objectPath)) {
      return json({ error: 'Đường dẫn tệp karaoke không hợp lệ.' }, 400);
    }
    temporaryObjectPath = objectPath;
    const { data: audio, error: downloadError } = await admin.storage.from('karaoke-inputs').download(objectPath);
    if (downloadError) throw downloadError;
    if (!audio || audio.size <= 0 || audio.size > 25 * 1024 * 1024 || !audio.type.startsWith('audio/')) {
      return json({ error: 'Tệp karaoke phải là âm thanh hợp lệ và có dung lượng tối đa 25 MB.' }, 413);
    }

    const upload = new FormData();
    upload.set('content', new File([audio], 'spotisix-audio', { type: audio.type }), 'spotisix-audio');
    const uploadResponse = await fetch('https://api.replicate.com/v1/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${replicateToken}` },
      body: upload,
    });
    const uploadedFile = await uploadResponse.json();
    if (!uploadResponse.ok || typeof uploadedFile.urls?.get !== 'string') {
      throw new Error(uploadedFile.detail || uploadedFile.error || 'Không thể gửi tệp lên dịch vụ tách vocal.');
    }

    const predictionResponse = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${replicateToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version: modelVersion,
        input: { audio: uploadedFile.urls.get },
      }),
    });
    const prediction = await predictionResponse.json();
    if (!predictionResponse.ok || typeof prediction.id !== 'string') {
      throw new Error(prediction.detail || prediction.error || 'Không thể bắt đầu model tách vocal.');
    }

    const { data: job, error: insertError } = await admin
      .from('karaoke_jobs')
      .insert({ user_id: user.id, prediction_id: prediction.id })
      .select('id')
      .single();
    if (insertError) throw insertError;
    return json({ status: prediction.status, jobId: job.id }, 202);
  } catch (error) {
    console.error('Karaoke processing failed.', error);
    return json({ error: error instanceof Error ? error.message : 'Không thể xử lý karaoke.' }, 502);
  } finally {
    if (temporaryObjectPath) {
      const { error } = await admin.storage.from('karaoke-inputs').remove([temporaryObjectPath]);
      if (error) console.error('Could not delete temporary karaoke upload.', error);
    }
  }
});

function getStemUrls(output: unknown): { vocalsUrl: string; instrumentalUrl: string } | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const stems = output as Record<string, unknown>;
  const vocalsUrl = findUrl(stems.vocals) || findUrl(stems.vocal);
  const instrumentalUrl =
    findUrl(stems.instrumental) ||
    findUrl(stems.no_vocals) ||
    findUrl(stems.accompaniment) ||
    findUrl(stems.instruments);
  return vocalsUrl && instrumentalUrl ? { vocalsUrl, instrumentalUrl } : null;
}

function findUrl(value: unknown): string | null {
  if (typeof value === 'string' && /^https:\/\//.test(value)) return value;
  if (value && typeof value === 'object' && 'url' in value) {
    return findUrl((value as { url: unknown }).url);
  }
  return null;
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

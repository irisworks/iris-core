import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

/**
 * Returns a Supabase client if SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set,
 * otherwise returns null. All callers must handle the null case (file-based fallback).
 */
export function getDb(): SupabaseClient | null {
	const url = process.env.SUPABASE_URL;
	const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
	if (!url || !key) return null;
	if (!_client) _client = createClient(url, key);
	return _client;
}

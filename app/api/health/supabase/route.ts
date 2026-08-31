import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export async function GET() {
  const { data, error } = await supabase.from('traits').select('*').limit(5)
  return NextResponse.json({ ok: error == null, data, error: error?.message ?? null })
}

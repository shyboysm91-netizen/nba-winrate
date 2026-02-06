// src/components/LogoutButton.tsx
'use client'

import { supabase } from '@/lib/supabase/client'

export default function LogoutButton() {
  const handleLogout = async () => {
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  return (
    <button
      onClick={handleLogout}
      style={{ padding: 10, borderRadius: 8, border: '1px solid #ddd' }}
    >
      로그아웃
    </button>
  )
}


import { useState } from 'react';

export default function Home() {
  const [zip, setZip] = useState('');
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState(null);

  async function check() {
    setErr(null);
    setRes(null);
    setLoading(true);
    try {
      const r = await fetch(`/api/coverage?zip=${encodeURIComponent(zip.trim())}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || `Request failed: ${r.status}`);
      setRes(data);
    } catch (e) {
      setErr(e?.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{fontFamily:'ui-sans-serif,system-ui', padding:'24px', maxWidth: 720, margin:'0 auto'}}>
      <h1 style={{fontSize: '20px', fontWeight: 600}}>Toast Go 3 — LTE Coverage Checker</h1>
      <p style={{color:'#555'}}>Enter a US ZIP. We’ll compare detected carriers to FloLive EU2/US2.</p>
      <div style={{display:'flex', gap: 8, marginTop: 8}}>
        <input
          value={zip}
          onChange={(e)=>setZip(e.target.value)}
          placeholder="e.g., 02139"
          maxLength={10}
          style={{flex:1, padding:'10px', border:'1px solid #ddd', borderRadius:8}}
        />
        <button onClick={check} disabled={!zip || loading} style={{padding:'10px 16px', borderRadius:8, background:'#111', color:'#fff', opacity: (!zip||loading)?0.6:1}}>
          {loading ? 'Checking…' : 'Check'}
        </button>
      </div>

      {err && <div style={{color:'#b00', marginTop: 12}}>{err}</div>}

      {res && (
        <div style={{border:'1px solid #eee', borderRadius:12, padding:16, marginTop:16}}>
          <div style={{fontWeight:600, marginBottom:8}}>
            Will TG3 connect? <span style={{color: res.connects ? '#0a0' : '#b00'}}>{res.connects ? 'Yes' : 'No'}</span>
          </div>
          <div>
            <div style={{color:'#666', fontSize: 14}}>Networks from FloLive EU2/US2 that match:</div>
            {res.networks?.length ? (
              <ul>
                {res.networks.map(n => <li key={n}>{n}</li>)}
              </ul>
            ) : <div>None</div>}
          </div>
          {res.reason && (
            <div style={{marginTop: 8, fontSize:14}}>
              <b>Why not:</b> {res.reason}
            </div>
          )}
          {res.rawProviders?.length ? (
            <details style={{marginTop: 8, fontSize:12, color:'#666'}}>
              <summary>Detected carriers/tower owners in this ZIP</summary>
              <ul>
                {res.rawProviders.map((p,i)=>(<li key={i}>{p}</li>))}
              </ul>
            </details>
          ): null}
        </div>
      )}

      <p style={{color:'#777', fontSize:12, marginTop:16}}>
        Note: Public tower data can be incomplete or mislabeled. For mission‑critical rollouts, confirm with a site survey or official carrier maps.
      </p>
    </div>
  );
}

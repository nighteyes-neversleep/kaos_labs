import { useCallback, useEffect, useRef, useState } from 'react';
import { loadSignedCartridge, validCartridgeData, type VerifiedCartridge } from '../core/cartridges';

type Props = { appId: string; data: unknown; onSave: (data: unknown) => void | Promise<void>; onClose: () => void };

export function CartridgeHost({ appId, data, onSave, onClose }: Props) {
  const [cartridge, setCartridge] = useState<VerifiedCartridge | null>(null);
  const [error, setError] = useState('');
  const frame = useRef<HTMLIFrameElement>(null);
  const currentData = useRef(data);
  const currentSave = useRef(onSave);
  const currentClose = useRef(onClose);
  currentData.current = data;
  currentSave.current = onSave;
  currentClose.current = onClose;
  useEffect(() => {
    const controller = new AbortController();
    setCartridge(null);
    setError('');
    loadSignedCartridge(appId, controller.signal).then(setCartridge).catch(error => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Cartridge loading failed.');
    });
    return () => controller.abort();
  }, [appId]);
  const initialize = useCallback(() => {
    // An opaque-origin iframe requires '*'; the concrete WindowProxy is the recipient.
    frame.current?.contentWindow?.postMessage({ type: 'omi:init', appId, data: currentData.current ?? null }, '*');
  }, [appId]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (!frame.current?.contentWindow || event.source !== frame.current.contentWindow || !event.data || event.data.appId !== appId) return;
      if (event.data.type === 'omi:ready') initialize();
      if (event.data.type === 'omi:close') currentClose.current();
      if (event.data.type === 'omi:save') {
        if (!validCartridgeData(event.data.data)) { setError('The cartridge sent invalid board data. It was not saved.'); return; }
        const recipient = frame.current.contentWindow;
        const requestId = event.data.requestId;
        Promise.resolve().then(() => currentSave.current(structuredClone(event.data.data))).then(() => {
          recipient?.postMessage({ type: 'omi:saved', appId, requestId }, '*');
        }).catch(error => {
          const detail = error instanceof Error ? error.message : 'Your board could not be saved.';
          setError(detail);
          recipient?.postMessage({ type: 'omi:save-error', appId, requestId, error: detail }, '*');
        });
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [appId, initialize]);
  return <section className="cartridge-host" aria-label="Mounted Eagle’s Nest cartridge">
    <div className="section-heading" style={{ display: 'flex', gap: '1rem', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
      <div><h2>Eagle’s Nest</h2><p>{cartridge ? 'Signature verified · isolated local cartridge' : 'Verifying signed cartridge…'}</p></div>
      <button onClick={onClose}>Close cartridge</button>
    </div>
    {error && <p role="alert" className="error">{error}</p>}
    {cartridge && <>
      <iframe ref={frame} title="Eagle’s Nest family board" sandbox="allow-scripts" referrerPolicy="no-referrer"
        allow="camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'"
        srcDoc={cartridge.html} onLoad={initialize}
        style={{ width: '100%', minHeight: 690, border: '1px solid #38303f', borderRadius: 16, background: '#151119' }} />
      <p className="muted" style={{ fontSize: 12 }}>Signed by {cartridge.signer}. Camera, microphone, network, and direct capsule access are blocked.</p>
    </>}
  </section>;
}

export default CartridgeHost;

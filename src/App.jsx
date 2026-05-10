import React, { useState, useEffect, useRef } from 'react';
import {
  Zap, RotateCcw, Play, Pause, Activity, Gauge,
  Thermometer, Pill, Network, Waves
} from 'lucide-react';

// ===== HH rate funksiyaları (V mV-də) =====
const alphaN = (V) => {
  const d = 1 - Math.exp(-(V + 55) / 10);
  return Math.abs(d) < 1e-6 ? 0.1 : 0.01 * (V + 55) / d;
};
const betaN = (V) => 0.125 * Math.exp(-(V + 65) / 80);
const alphaM = (V) => {
  const d = 1 - Math.exp(-(V + 40) / 10);
  return Math.abs(d) < 1e-6 ? 1.0 : 0.1 * (V + 40) / d;
};
const betaM = (V) => 4 * Math.exp(-(V + 65) / 18);
const alphaH = (V) => 0.07 * Math.exp(-(V + 65) / 20);
const betaH = (V) => 1 / (1 + Math.exp(-(V + 35) / 10));
const clip01 = (x) => Math.max(0, Math.min(1, x));

// ===== Sabitlər =====
const Cm = 1.0;
const gNa_base = 120, gK_base = 36, gL = 0.3;
const ENa = 50, EK = -77, EL = -54.387;
const dt = 0.025;
const T_REF = 6.3; // HH original
const Q10_GATING = 3;
const Q10_COND = 1.3;
const windowMs = 100;

// İlkin sakitlik vəziyyəti
const restState = () => ({
  V: -65, m: 0.0529, h: 0.5961, n: 0.3177,
});

export default function NeuroLab() {
  const MODE = { CC: 'cc', VC: 'vc', SYN: 'syn' };
  const [mode, setMode] = useState(MODE.CC);

  // Qlobal idarələr
  const [temperature, setTemperature] = useState(6.3);
  const [ttx, setTtx] = useState(0);  // % blok
  const [tea, setTea] = useState(0);
  const [speed, setSpeed] = useState(0.05);
  const [isRunning, setIsRunning] = useState(true);

  // CC parametrləri
  const [stimAmp, setStimAmp] = useState(15);
  const [stimDur, setStimDur] = useState(0.8);
  const [stimMode, setStimMode] = useState('single');
  const [isi, setIsi] = useState(8);
  const [trainFreq, setTrainFreq] = useState(80);
  const [trainCount, setTrainCount] = useState(5);

  // VC parametrləri
  const [vHold, setVHold] = useState(-65);
  const [vCmd, setVCmd] = useState(0);
  const [vStepDur, setVStepDur] = useState(15);

  // Sinaps parametrləri
  const [synWeight, setSynWeight] = useState(0.5);
  const [synType, setSynType] = useState('exc'); // exc | inh
  const [synDelay, setSynDelay] = useState(1);
  const [synTau, setSynTau] = useState(2);

  const [readout, setReadout] = useState({
    V: -65, V2: -65, m: 0.0529, h: 0.5961, n: 0.3177,
    INa: 0, IK: 0, gSyn: 0, t: 0, stimActive: false,
  });

  // ===== Refs (loop üçün canlı dəyərlər) =====
  const canvasRef = useRef(null);
  const animRef = useRef(null);
  const modeRef = useRef(mode);
  const speedRef = useRef(speed);
  const isRunningRef = useRef(isRunning);
  const tempRef = useRef(temperature);
  const ttxRef = useRef(ttx);
  const teaRef = useRef(tea);
  const stimAmpRef = useRef(stimAmp);
  const vHoldRef = useRef(vHold);
  const vCmdRef = useRef(vCmd);
  const synWeightRef = useRef(synWeight);
  const synTypeRef = useRef(synType);
  const synDelayRef = useRef(synDelay);
  const synTauRef = useRef(synTau);

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { speedRef.current = speed; }, [speed]);
  useEffect(() => { isRunningRef.current = isRunning; }, [isRunning]);
  useEffect(() => { tempRef.current = temperature; }, [temperature]);
  useEffect(() => { ttxRef.current = ttx; }, [ttx]);
  useEffect(() => { teaRef.current = tea; }, [tea]);
  useEffect(() => { stimAmpRef.current = stimAmp; }, [stimAmp]);
  useEffect(() => { vHoldRef.current = vHold; }, [vHold]);
  useEffect(() => { vCmdRef.current = vCmd; }, [vCmd]);
  useEffect(() => { synWeightRef.current = synWeight; }, [synWeight]);
  useEffect(() => { synTypeRef.current = synType; }, [synType]);
  useEffect(() => { synDelayRef.current = synDelay; }, [synDelay]);
  useEffect(() => { synTauRef.current = synTau; }, [synTau]);

  const stateRef = useRef({
    n1: restState(),
    n2: restState(),
    t: 0,
    pulses: [],          // CC: cərəyan impulsları
    vcStep: null,        // VC: aktiv addım {start, end}
    synSpikes: [],       // SYN: pre-AP zamanları
    n1_Vprev: -65,       // spike detektoru üçün
    points: [],          // əsas iz (V və ya I — moddan asılı)
    points2: [],         // ikinci iz (V2 SYN-də, IK VC-də)
    pointsExtra: [],     // VC-də Vc(t)
  });

  // ===== Şriftlər =====
  useEffect(() => {
    const link = document.createElement('link');
    link.href = 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Inter:wght@400;500;600&display=swap';
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }, []);

  // ===== Reset (mod dəyişdikdə) =====
  const reset = () => {
    stateRef.current = {
      n1: restState(), n2: restState(), t: 0,
      pulses: [], vcStep: null, synSpikes: [],
      n1_Vprev: -65, points: [], points2: [], pointsExtra: [],
    };
  };
  useEffect(() => { reset(); }, [mode]);

  // ===== Stimul (CC və SYN üçün eyni) =====
  const triggerStim = () => {
    const s = stateRef.current;
    if (modeRef.current === MODE.VC) {
      // VC: addım protokolu
      s.vcStep = { start: s.t, end: s.t + vStepDur };
      return;
    }
    const tNow = s.t;
    if (stimMode === 'single') {
      s.pulses.push({ start: tNow, end: tNow + stimDur });
    } else if (stimMode === 'double') {
      s.pulses.push({ start: tNow, end: tNow + stimDur });
      s.pulses.push({ start: tNow + isi, end: tNow + isi + stimDur });
    } else if (stimMode === 'train') {
      const period = 1000 / trainFreq;
      for (let i = 0; i < trainCount; i++) {
        s.pulses.push({
          start: tNow + i * period,
          end: tNow + i * period + stimDur,
        });
      }
    }
  };

  // ===== Bir neyronun bir addımını icra et =====
  const stepNeuron = (n, params, dt_local) => {
    const { gNa, gK, phiGate, I_inj, clampV } = params;
    const INa = gNa * Math.pow(n.m, 3) * n.h * (n.V - ENa);
    const IK = gK * Math.pow(n.n, 4) * (n.V - EK);
    const IL = gL * (n.V - EL);

    const dm = phiGate * (alphaM(n.V) * (1 - n.m) - betaM(n.V) * n.m);
    const dh = phiGate * (alphaH(n.V) * (1 - n.h) - betaH(n.V) * n.h);
    const dn = phiGate * (alphaN(n.V) * (1 - n.n) - betaN(n.V) * n.n);

    if (clampV !== undefined && clampV !== null) {
      n.V = clampV;
    } else {
      const dV = (I_inj - INa - IK - IL) / Cm;
      n.V += dV * dt_local;
    }
    n.m = clip01(n.m + dm * dt_local);
    n.h = clip01(n.h + dh * dt_local);
    n.n = clip01(n.n + dn * dt_local);

    return { INa, IK, IL };
  };

  // ===== Animasiya =====
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let W = 0, H = 0;
    const setupCanvas = () => {
      const dpr = window.devicePixelRatio || 1;
      const r = canvas.getBoundingClientRect();
      canvas.width = r.width * dpr;
      canvas.height = r.height * dpr;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      W = r.width; H = r.height;
    };
    setupCanvas();
    const onResize = () => setupCanvas();
    window.addEventListener('resize', onResize);

    let lastStamp = performance.now();

    const loop = (now) => {
      const elapsed = Math.min(now - lastStamp, 50);
      lastStamp = now;

      if (isRunningRef.current) {
        const simMs = elapsed * speedRef.current;
        const steps = Math.ceil(simMs / dt);
        const s = stateRef.current;

        const T = tempRef.current;
        const phiGate = Math.pow(Q10_GATING, (T - T_REF) / 10);
        const phiCond = Math.pow(Q10_COND, (T - T_REF) / 10);
        const gNa = gNa_base * phiCond * (1 - ttxRef.current / 100);
        const gK = gK_base * phiCond * (1 - teaRef.current / 100);

        for (let i = 0; i < steps; i++) {
          const m = modeRef.current;
          let mainPoint = null, secondPoint = null, extraPoint = null;
          let stimActive = false;

          if (m === MODE.CC) {
            // Cərəyan klamp
            stimActive = s.pulses.some(p => s.t >= p.start && s.t < p.end);
            const I_inj = stimActive ? stimAmpRef.current : 0;
            stepNeuron(s.n1, { gNa, gK, phiGate, I_inj }, dt);
            mainPoint = { t: s.t, V: s.n1.V, stim: stimActive };
          }
          else if (m === MODE.VC) {
            // Voltaj klamp
            const inStep = s.vcStep && s.t >= s.vcStep.start && s.t < s.vcStep.end;
            stimActive = inStep;
            const Vc = inStep ? vCmdRef.current : vHoldRef.current;
            const cur = stepNeuron(s.n1, { gNa, gK, phiGate, clampV: Vc }, dt);
            mainPoint = { t: s.t, V: cur.INa, stim: stimActive };  // INa
            secondPoint = { t: s.t, V: cur.IK };                    // IK
            extraPoint = { t: s.t, V: Vc };                         // command V
            if (s.vcStep && s.t > s.vcStep.end + 5) s.vcStep = null;
          }
          else if (m === MODE.SYN) {
            // İki neyron sinaps ilə
            stimActive = s.pulses.some(p => s.t >= p.start && s.t < p.end);
            const I_inj1 = stimActive ? stimAmpRef.current : 0;

            // Neyron 1 (presinaptik)
            stepNeuron(s.n1, { gNa, gK, phiGate, I_inj: I_inj1 }, dt);

            // Spike detektoru: V_pre 0 mV-dan yuxarı keçəndə
            if (s.n1_Vprev < 0 && s.n1.V >= 0) {
              s.synSpikes.push(s.t);
            }
            s.n1_Vprev = s.n1.V;

            // Sinaptik keçiricilik (alpha funksiya)
            let g_syn = 0;
            const tau = synTauRef.current;
            const delay = synDelayRef.current;
            for (const ts of s.synSpikes) {
              const dts = s.t - ts - delay;
              if (dts > 0 && dts < 6 * tau) {
                g_syn += synWeightRef.current * (dts / tau) * Math.exp(1 - dts / tau);
              }
            }
            // Köhnə spike-ları təmizlə
            s.synSpikes = s.synSpikes.filter(ts => s.t - ts < 6 * tau + delay);

            // Neyron 2 (postsinaptik)
            const E_syn = synTypeRef.current === 'exc' ? 0 : -75;
            const I_syn = -g_syn * (s.n2.V - E_syn); // mənfi: cərəyan içəri (eksitator)
            stepNeuron(s.n2, { gNa, gK, phiGate, I_inj: I_syn }, dt);

            mainPoint = { t: s.t, V: s.n1.V, stim: stimActive };
            secondPoint = { t: s.t, V: s.n2.V, gSyn: g_syn };
          }

          s.t += dt;

          // Trase nöqtələri
          const lastT = s.points.length ? s.points[s.points.length - 1].t : -1;
          if (s.t - lastT > 0.05) {
            s.points.push(mainPoint);
            if (secondPoint) s.points2.push(secondPoint);
            if (extraPoint) s.pointsExtra.push(extraPoint);
            const cutoff = s.t - windowMs;
            while (s.points.length && s.points[0].t < cutoff) s.points.shift();
            while (s.points2.length && s.points2[0].t < cutoff) s.points2.shift();
            while (s.pointsExtra.length && s.pointsExtra[0].t < cutoff) s.pointsExtra.shift();
          }
        }

        // Köhnə impulsları təmizlə
        const cutoff = s.t - windowMs;
        s.pulses = s.pulses.filter(p => p.end > cutoff);
      }

      // ===== Çəkim =====
      drawCanvas(ctx, W, H);
      animRef.current = requestAnimationFrame(loop);
    };

    animRef.current = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(animRef.current);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  // ===== Canvas çəkim funksiyası =====
  const drawCanvas = (ctx, W, H) => {
    const s = stateRef.current;
    const m = modeRef.current;
    const tNow = s.t;

    ctx.clearRect(0, 0, W, H);
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0a0f1c');
    bg.addColorStop(1, '#050810');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    const xOf = (t) => W - (tNow - t) * (W / windowMs);

    if (m === MODE.CC) {
      drawVoltagePanel(ctx, 0, 0, W, H, s.points, s.pulses, '#4ade80', xOf, true);
    } else if (m === MODE.VC) {
      // Yuxarıda command V (1/3), aşağıda cərəyanlar (2/3)
      const topH = H * 0.32;
      drawCommandPanel(ctx, 0, 0, W, topH, s.pointsExtra, xOf);
      drawCurrentPanel(ctx, 0, topH, W, H - topH, s.points, s.points2, xOf);
    } else if (m === MODE.SYN) {
      // Yuxarı: pre, aşağı: post
      const halfH = H / 2;
      drawVoltagePanel(ctx, 0, 0, W, halfH, s.points, s.pulses, '#4ade80', xOf, false, 'V_pre');
      drawVoltagePanel(ctx, 0, halfH, W, halfH, s.points2, [], '#fbbf24', xOf, false, 'V_post');
      // Bölücü xətt
      ctx.strokeStyle = 'rgba(148,163,184,0.2)';
      ctx.beginPath(); ctx.moveTo(0, halfH); ctx.lineTo(W, halfH); ctx.stroke();
    }
  };

  const drawGrid = (ctx, x0, y0, W, H, yMin, yMax, lines) => {
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.07)';
    ctx.lineWidth = 1;
    lines.forEach(v => {
      const y = y0 + H - (v - yMin) * (H / (yMax - yMin));
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + W, y); ctx.stroke();
    });
    for (let dx = 0; dx < W; dx += W / 10) {
      ctx.beginPath(); ctx.moveTo(x0 + dx, y0); ctx.lineTo(x0 + dx, y0 + H); ctx.stroke();
    }
  };

  const drawVoltagePanel = (ctx, x0, y0, W, H, points, pulses, color, xOf, showLabels, label) => {
    const Vmin = -90, Vmax = 60;
    const yOf = (V) => y0 + H - (V - Vmin) * (H / (Vmax - Vmin));

    // Stimul zolaqları
    ctx.fillStyle = 'rgba(251, 191, 36, 0.12)';
    pulses.forEach(p => {
      const x1 = xOf(Math.max(p.start, stateRef.current.t - windowMs));
      const x2 = xOf(Math.min(p.end, stateRef.current.t));
      if (x2 > x1) ctx.fillRect(x1, y0, x2 - x1, H);
    });

    drawGrid(ctx, x0, y0, W, H, Vmin, Vmax, [-80, -60, -40, -20, 0, 20, 40, 60]);

    // Eşik və sakitlik
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.3)';
    ctx.setLineDash([5, 5]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, yOf(-55)); ctx.lineTo(x0 + W, yOf(-55)); ctx.stroke();
    ctx.strokeStyle = 'rgba(96, 165, 250, 0.3)';
    ctx.beginPath(); ctx.moveTo(x0, yOf(-65)); ctx.lineTo(x0 + W, yOf(-65)); ctx.stroke();
    ctx.setLineDash([]);

    // Trase
    if (points.length > 1) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      points.forEach((p, i) => {
        const x = xOf(p.t);
        const y = yOf(p.V);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Etiketlər
    ctx.fillStyle = 'rgba(148, 163, 184, 0.65)';
    ctx.font = '10px "JetBrains Mono", monospace';
    if (showLabels) {
      [60, 40, 0, -40, -55, -65, -77].forEach(v => {
        ctx.fillText(`${v}`, x0 + 4, yOf(v) - 2);
      });
      ctx.fillStyle = 'rgba(251, 191, 36, 0.85)';
      ctx.fillText('eşik (−55 mV)', x0 + W - 110, yOf(-55) - 4);
    } else {
      [60, 0, -65].forEach(v => {
        ctx.fillText(`${v}`, x0 + 4, yOf(v) - 2);
      });
    }
    if (label) {
      ctx.fillStyle = color;
      ctx.font = '12px "Cormorant Garamond", serif';
      ctx.fillText(label, x0 + W - 70, y0 + 16);
    }
  };

  const drawCommandPanel = (ctx, x0, y0, W, H, points, xOf) => {
    const Vmin = -100, Vmax = 60;
    const yOf = (V) => y0 + H - (V - Vmin) * (H / (Vmax - Vmin));

    drawGrid(ctx, x0, y0, W, H, Vmin, Vmax, [-80, -40, 0, 40]);

    if (points.length > 1) {
      ctx.strokeStyle = '#a78bfa';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#a78bfa';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      points.forEach((p, i) => {
        const x = xOf(p.t);
        const y = yOf(p.V);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    ctx.fillStyle = 'rgba(148, 163, 184, 0.65)';
    ctx.font = '10px "JetBrains Mono", monospace';
    [40, 0, -40, -80].forEach(v => {
      ctx.fillText(`${v}`, x0 + 4, yOf(v) - 2);
    });
    ctx.fillStyle = '#a78bfa';
    ctx.font = '12px "Cormorant Garamond", serif';
    ctx.fillText('Vc (komanda)', x0 + W - 100, y0 + 16);
  };

  const drawCurrentPanel = (ctx, x0, y0, W, H, pointsINa, pointsIK, xOf) => {
    // Cərəyanlar: təxminən -800 ila +400 µA/cm²
    const Imin = -800, Imax = 400;
    const yOf = (I) => y0 + H - (I - Imin) * (H / (Imax - Imin));

    drawGrid(ctx, x0, y0, W, H, Imin, Imax, [-600, -300, 0, 300]);

    // Sıfır xətti
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, yOf(0)); ctx.lineTo(x0 + W, yOf(0)); ctx.stroke();

    // INa (qırmızı, daxili = mənfi)
    if (pointsINa.length > 1) {
      ctx.strokeStyle = '#fb7185';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#fb7185';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      pointsINa.forEach((p, i) => {
        const x = xOf(p.t);
        const y = yOf(p.V);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    // IK (mavi, xarici = müsbət)
    if (pointsIK.length > 1) {
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#38bdf8';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      pointsIK.forEach((p, i) => {
        const x = xOf(p.t);
        const y = yOf(p.V);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    ctx.fillStyle = 'rgba(148, 163, 184, 0.65)';
    ctx.font = '10px "JetBrains Mono", monospace';
    [300, 0, -300, -600].forEach(v => {
      ctx.fillText(`${v}`, x0 + 4, yOf(v) - 2);
    });
    ctx.fillStyle = '#fb7185';
    ctx.font = '12px "Cormorant Garamond", serif';
    ctx.fillText('I_Na (içəri ↓)', x0 + W - 110, y0 + 16);
    ctx.fillStyle = '#38bdf8';
    ctx.fillText('I_K (çölə ↑)', x0 + W - 110, y0 + 32);
  };

  // ===== Oxunuşlar =====
  useEffect(() => {
    const id = setInterval(() => {
      const s = stateRef.current;
      const T = tempRef.current;
      const phiCond = Math.pow(Q10_COND, (T - T_REF) / 10);
      const gNa = gNa_base * phiCond * (1 - ttxRef.current / 100);
      const gK = gK_base * phiCond * (1 - teaRef.current / 100);
      const INa = gNa * Math.pow(s.n1.m, 3) * s.n1.h * (s.n1.V - ENa);
      const IK = gK * Math.pow(s.n1.n, 4) * (s.n1.V - EK);
      const stimActive =
        modeRef.current === MODE.VC
          ? !!(s.vcStep && s.t >= s.vcStep.start && s.t < s.vcStep.end)
          : s.pulses.some(p => s.t >= p.start && s.t < p.end);
      // Sinaptik keçiricilik (oxunuş üçün)
      let g_syn = 0;
      const tau = synTauRef.current, delay = synDelayRef.current;
      for (const ts of s.synSpikes) {
        const dts = s.t - ts - delay;
        if (dts > 0 && dts < 6 * tau) {
          g_syn += synWeightRef.current * (dts / tau) * Math.exp(1 - dts / tau);
        }
      }
      setReadout({
        V: s.n1.V, V2: s.n2.V,
        m: s.n1.m, h: s.n1.h, n: s.n1.n,
        INa, IK, gSyn: g_syn, t: s.t, stimActive
      });
    }, 80);
    return () => clearInterval(id);
  }, []);

  // ===== UI köməkçiləri =====
  const Bar = ({ value, color }) => (
    <div className="w-full h-2 bg-slate-800/60 rounded-full overflow-hidden">
      <div className="h-full rounded-full transition-all duration-100"
        style={{
          width: `${Math.max(0, Math.min(100, value * 100))}%`,
          background: color, boxShadow: `0 0 8px ${color}`,
        }} />
    </div>
  );
  const Slider = ({ label, value, set, min, max, step, unit, accent = 'emerald', hint }) => (
    <div>
      <div className="flex justify-between items-baseline mb-2">
        <label className="text-sm text-slate-300">{label}</label>
        <span className={`text-${accent}-300 text-sm`} style={fontMono}>
          {typeof value === 'number' ? value.toFixed(step >= 1 ? 0 : 1) : value} {unit}
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => set(parseFloat(e.target.value))}
        className={`w-full accent-${accent}-500`} />
      {hint && <div className="text-[10px] text-slate-500 mt-1" style={fontMono}>{hint}</div>}
    </div>
  );

  const fontDisplay = { fontFamily: '"Cormorant Garamond", Georgia, serif' };
  const fontMono = { fontFamily: '"JetBrains Mono", ui-monospace, monospace' };
  const fontBody = { fontFamily: '"Inter", system-ui, sans-serif' };

  const speedLabel = speed >= 0.3 ? `${speed.toFixed(2)}× (sürətli)`
    : speed >= 0.08 ? `${speed.toFixed(2)}× (orta)`
    : `${speed.toFixed(3)}× (yavaş)`;

  // Q10 göstərici (T effekti)
  const phiGate = Math.pow(Q10_GATING, (temperature - T_REF) / 10);

  return (
    <div className="min-h-screen w-full bg-slate-950 text-slate-100 p-4 md:p-6" style={fontBody}>
      <div className="max-w-7xl mx-auto">

        <header className="mb-5 border-b border-slate-800 pb-4">
          <h1 className="text-4xl md:text-5xl tracking-tight text-emerald-300" style={fontDisplay}>
            Hodgkin–Huxley Laboratoriyası
          </h1>
          <p className="mt-1 text-slate-400 text-sm italic" style={fontDisplay}>
            cərəyan klamp · voltaj klamp · sinaps · temperatur · farmakologiya
          </p>
        </header>

        {/* Mode tabs */}
        <div className="flex gap-2 mb-5 flex-wrap">
          {[
            { id: MODE.CC, label: 'Cərəyan klamp', icon: Activity },
            { id: MODE.VC, label: 'Voltaj klamp', icon: Waves },
            { id: MODE.SYN, label: 'İki neyron (sinaps)', icon: Network },
          ].map(t => {
            const Icon = t.icon;
            return (
              <button key={t.id} onClick={() => setMode(t.id)}
                className={`flex items-center gap-2 px-4 py-2 rounded-md border transition-all
                  ${mode === t.id
                    ? 'bg-emerald-500/20 border-emerald-400 text-emerald-200'
                    : 'bg-slate-800/40 border-slate-700 text-slate-400 hover:bg-slate-800'}`}>
                <Icon className="w-4 h-4" />
                <span className="text-sm font-medium">{t.label}</span>
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

          {/* SOL: kanvas + əsas idarələr */}
          <div className="lg:col-span-2 space-y-4">
            <div className="bg-slate-900/60 border border-slate-800 rounded-lg overflow-hidden">
              <div className="px-4 py-2 border-b border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Activity className={`w-4 h-4 ${readout.stimActive ? 'text-amber-400' : 'text-emerald-400'}`} />
                  <span className="text-xs uppercase tracking-widest text-slate-400">
                    {mode === MODE.CC && 'Membran potensialı'}
                    {mode === MODE.VC && 'Voltaj klamp — komanda və cərəyanlar'}
                    {mode === MODE.SYN && 'Pre və post sinaptik neyronlar'}
                  </span>
                </div>
                <span className="text-xs text-slate-500" style={fontMono}>
                  t = {readout.t.toFixed(1)} ms
                </span>
              </div>
              <canvas ref={canvasRef} className="w-full block" style={{ height: '420px' }} />
            </div>

            {/* Düymələr */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <button onClick={triggerStim}
                className={`flex items-center justify-center gap-2 py-3 px-4 rounded-md border transition-all
                  ${readout.stimActive
                    ? 'bg-amber-500 border-amber-400 text-slate-900 shadow-lg shadow-amber-500/40'
                    : 'bg-amber-500/10 border-amber-500/40 text-amber-300 hover:bg-amber-500/20'}`}>
                <Zap className="w-4 h-4" />
                <span className="font-semibold text-sm">
                  {mode === MODE.VC ? 'Addım ver' : 'Stimullaşdır'}
                </span>
              </button>
              <button onClick={() => setIsRunning(r => !r)}
                className="flex items-center justify-center gap-2 py-3 px-4 rounded-md border border-slate-700 bg-slate-800/50 text-slate-200 hover:bg-slate-800 transition-all">
                {isRunning ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                <span className="font-semibold text-sm">{isRunning ? 'Dayandır' : 'İşlət'}</span>
              </button>
              <button onClick={reset}
                className="flex items-center justify-center gap-2 py-3 px-4 rounded-md border border-slate-700 bg-slate-800/50 text-slate-200 hover:bg-slate-800 transition-all">
                <RotateCcw className="w-4 h-4" />
                <span className="font-semibold text-sm">Sıfırla</span>
              </button>
            </div>

            {/* Sürət — həmişə görünür */}
            <div className="bg-slate-900/40 border border-slate-800 rounded-lg p-4">
              <div className="flex justify-between items-baseline mb-2">
                <label className="text-sm text-slate-300 flex items-center gap-2">
                  <Gauge className="w-4 h-4 text-emerald-400" /> Simulyasiya sürəti
                </label>
                <span className="text-emerald-300 text-sm" style={fontMono}>{speedLabel}</span>
              </div>
              <input type="range" min="0.005" max="0.5" step="0.005" value={speed}
                onChange={(e) => setSpeed(parseFloat(e.target.value))}
                className="w-full accent-emerald-500" />
            </div>

            {/* Mode-specific controls */}
            {mode === MODE.CC && (
              <div className="bg-slate-900/40 border border-slate-800 rounded-lg p-4 space-y-4">
                <div>
                  <div className="text-xs uppercase tracking-widest text-slate-400 mb-2">
                    Stimul rejimi
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { id: 'single', label: 'Tək' },
                      { id: 'double', label: 'Cüt' },
                      { id: 'train', label: 'Qatar' },
                    ].map(opt => (
                      <button key={opt.id} onClick={() => setStimMode(opt.id)}
                        className={`py-2 px-3 rounded-md text-sm border transition-all
                          ${stimMode === opt.id
                            ? 'bg-emerald-500/20 border-emerald-400 text-emerald-200'
                            : 'bg-slate-800/40 border-slate-700 text-slate-400 hover:bg-slate-800'}`}>
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <Slider label="Amplituda" value={stimAmp} set={setStimAmp}
                  min={0} max={50} step={0.5} unit="µA/cm²" />
                <Slider label="Hər impulsun müddəti" value={stimDur} set={setStimDur}
                  min={0.1} max={5} step={0.1} unit="ms" />
                {stimMode === 'double' && (
                  <Slider label="ISI (impulslar arası)" value={isi} set={setIsi}
                    min={1} max={30} step={0.5} unit="ms" accent="amber"
                    hint="Qısa → summasiya  ·  Çox qısa → refrakter" />
                )}
                {stimMode === 'train' && (
                  <>
                    <Slider label="Tezlik" value={trainFreq} set={setTrainFreq}
                      min={10} max={300} step={5} unit="Hz" accent="amber" />
                    <Slider label="İmpulsların sayı" value={trainCount} set={setTrainCount}
                      min={2} max={15} step={1} unit="" accent="amber" />
                  </>
                )}
              </div>
            )}

            {mode === MODE.VC && (
              <div className="bg-slate-900/40 border border-slate-800 rounded-lg p-4 space-y-4">
                <div className="text-xs text-slate-400 leading-relaxed border-l-2 border-violet-500/40 pl-3">
                  Voltaj klampda membran potensialı sabit saxlanılır. Komanda potensialına
                  addım edilir, qapı dəyişənləri sərbəst dəyişir, axınlar ölçülür.
                  Klassik kalmar aksonu eksperimentində Na⁺ tez içəri, K⁺ gec çölə axır.
                </div>
                <Slider label="Tutum potensialı (V_hold)" value={vHold} set={setVHold}
                  min={-100} max={-40} step={1} unit="mV" />
                <Slider label="Komanda potensialı (V_cmd)" value={vCmd} set={setVCmd}
                  min={-80} max={60} step={1} unit="mV" accent="amber" />
                <Slider label="Addımın müddəti" value={vStepDur} set={setVStepDur}
                  min={2} max={50} step={1} unit="ms" />
              </div>
            )}

            {mode === MODE.SYN && (
              <div className="bg-slate-900/40 border border-slate-800 rounded-lg p-4 space-y-4">
                <div className="text-xs text-slate-400 leading-relaxed border-l-2 border-emerald-500/40 pl-3">
                  Neyron 1 (üst, yaşıl) cərəyanla stimullaşdırılır. Hər AP sinaps vasitəsilə
                  neyron 2-yə (alt, sarı) ötürülür. EPSP-lər toplanaraq postsinaptik AP yarada bilər.
                </div>
                <div>
                  <div className="text-xs uppercase tracking-widest text-slate-400 mb-2">
                    Sinaps tipi
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { id: 'exc', label: 'Eksitator (E_syn = 0 mV)' },
                      { id: 'inh', label: 'İnhibitor (E_syn = −75 mV)' },
                    ].map(opt => (
                      <button key={opt.id} onClick={() => setSynType(opt.id)}
                        className={`py-2 px-3 rounded-md text-xs border transition-all
                          ${synType === opt.id
                            ? 'bg-emerald-500/20 border-emerald-400 text-emerald-200'
                            : 'bg-slate-800/40 border-slate-700 text-slate-400 hover:bg-slate-800'}`}>
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <Slider label="Sinaptik çəki (g_max)" value={synWeight} set={setSynWeight}
                  min={0} max={2} step={0.05} unit="mS/cm²"
                  hint="Yüksək → güclü EPSP  ·  Aşağı → subthreshold" />
                <Slider label="Sinaptik gecikmə" value={synDelay} set={setSynDelay}
                  min={0.1} max={5} step={0.1} unit="ms" />
                <Slider label="Sinaptik τ (söndürmə)" value={synTau} set={setSynTau}
                  min={0.5} max={10} step={0.5} unit="ms" />

                {/* Pre stimul üçün eyni nəzarətlər */}
                <div className="pt-3 border-t border-slate-800 space-y-3">
                  <div className="text-xs uppercase tracking-widest text-slate-400">
                    Presinaptik stimul (neyron 1)
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { id: 'single', label: 'Tək' },
                      { id: 'double', label: 'Cüt' },
                      { id: 'train', label: 'Qatar' },
                    ].map(opt => (
                      <button key={opt.id} onClick={() => setStimMode(opt.id)}
                        className={`py-2 px-2 rounded-md text-xs border transition-all
                          ${stimMode === opt.id
                            ? 'bg-emerald-500/20 border-emerald-400 text-emerald-200'
                            : 'bg-slate-800/40 border-slate-700 text-slate-400'}`}>
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <Slider label="Amplituda" value={stimAmp} set={setStimAmp}
                    min={0} max={50} step={0.5} unit="µA/cm²" />
                  {stimMode === 'train' && (
                    <Slider label="Tezlik" value={trainFreq} set={setTrainFreq}
                      min={10} max={300} step={5} unit="Hz" accent="amber" />
                  )}
                </div>
              </div>
            )}
          </div>

          {/* SAĞ: oxunuşlar + qlobal */}
          <div className="space-y-4">

            {/* Voltaj */}
            <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-4">
              <div className="text-xs uppercase tracking-widest text-slate-500 mb-2">
                {mode === MODE.SYN ? 'V₁ / V₂ (mV)' : 'Hazırkı V'}
              </div>
              <div className="text-3xl text-emerald-300" style={fontMono}>
                {readout.V.toFixed(1)}
                {mode === MODE.SYN && (
                  <span className="text-amber-300"> / {readout.V2.toFixed(1)}</span>
                )}
                <span className="text-sm text-slate-500 ml-1">mV</span>
              </div>
            </div>

            {/* Temperatur */}
            <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-4">
              <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-slate-500 mb-3">
                <Thermometer className="w-3.5 h-3.5 text-orange-400" /> Temperatur (Q₁₀)
              </div>
              <Slider label={`T = ${temperature.toFixed(1)} °C`} value={temperature} set={setTemperature}
                min={3} max={37} step={0.5} unit="" accent="orange" />
              <div className="text-[10px] text-slate-500 mt-2 leading-relaxed" style={fontMono}>
                Φ_qapı = {phiGate.toFixed(2)}× (HH 6.3°C)
              </div>
              <div className="text-[10px] text-slate-400 mt-1">
                3°C: arktik balıq · 6.3°C: HH original · 22°C: otaq · 37°C: məməli
              </div>
            </div>

            {/* Farmakologiya */}
            <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-4 space-y-3">
              <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-slate-500">
                <Pill className="w-3.5 h-3.5 text-rose-400" /> Farmakologiya
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-rose-300">TTX (Na⁺ blokadası)</span>
                  <span style={fontMono} className="text-rose-200">{ttx}%</span>
                </div>
                <input type="range" min="0" max="100" step="1" value={ttx}
                  onChange={(e) => setTtx(parseInt(e.target.value))}
                  className="w-full accent-rose-500" />
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-sky-300">TEA (K⁺ blokadası)</span>
                  <span style={fontMono} className="text-sky-200">{tea}%</span>
                </div>
                <input type="range" min="0" max="100" step="1" value={tea}
                  onChange={(e) => setTea(parseInt(e.target.value))}
                  className="w-full accent-sky-500" />
              </div>
              <div className="text-[10px] text-slate-500 leading-relaxed pt-1">
                <b className="text-rose-300">TTX</b>: pufferbalığın tetrodotoksini, Na⁺ kanallarını
                kənardan tıxac kimi tutur. <b className="text-sky-300">TEA</b>: tetraetilammonium,
                gecikmiş düzəldici K⁺ kanallarını blok edir.
              </div>
            </div>

            {/* Qapı dəyişənləri (yalnız CC və SYN) */}
            {mode !== MODE.VC && (
              <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-4 space-y-3">
                <div className="text-xs uppercase tracking-widest text-slate-500">
                  Qapı dəyişənləri (n1)
                </div>
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-rose-300">m</span>
                    <span style={fontMono} className="text-slate-300">{readout.m.toFixed(3)}</span>
                  </div>
                  <Bar value={readout.m} color="#fb7185" />
                </div>
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-orange-300">h</span>
                    <span style={fontMono} className="text-slate-300">{readout.h.toFixed(3)}</span>
                  </div>
                  <Bar value={readout.h} color="#fb923c" />
                </div>
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-sky-300">n</span>
                    <span style={fontMono} className="text-slate-300">{readout.n.toFixed(3)}</span>
                  </div>
                  <Bar value={readout.n} color="#38bdf8" />
                </div>
              </div>
            )}

            {/* Cərəyanlar / Sinaps */}
            <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-4 space-y-2">
              <div className="text-xs uppercase tracking-widest text-slate-500">
                {mode === MODE.SYN ? 'Sinaps' : 'İon cərəyanları'}
              </div>
              {mode === MODE.SYN ? (
                <div className="flex justify-between items-baseline">
                  <span className="text-sm text-amber-300">g_syn</span>
                  <span style={fontMono} className="text-amber-200 text-lg">
                    {readout.gSyn.toFixed(3)}
                    <span className="text-xs text-slate-500 ml-1">mS/cm²</span>
                  </span>
                </div>
              ) : (
                <>
                  <div className="flex justify-between items-baseline">
                    <span className="text-sm text-rose-300">I<sub>Na</sub></span>
                    <span style={fontMono} className="text-rose-200 text-lg">
                      {readout.INa.toFixed(1)}
                      <span className="text-xs text-slate-500 ml-1">µA/cm²</span>
                    </span>
                  </div>
                  <div className="flex justify-between items-baseline">
                    <span className="text-sm text-sky-300">I<sub>K</sub></span>
                    <span style={fontMono} className="text-sky-200 text-lg">
                      {readout.IK.toFixed(1)}
                      <span className="text-xs text-slate-500 ml-1">µA/cm²</span>
                    </span>
                  </div>
                </>
              )}
            </div>

            {/* Ssenarilər */}
            <div className="bg-slate-900/40 border border-slate-800 rounded-lg p-4 text-xs text-slate-400 leading-relaxed">
              <div className="text-emerald-300 font-semibold mb-2 text-sm" style={fontDisplay}>
                Klassik eksperimentlər
              </div>
              {mode === MODE.CC && (
                <ul className="space-y-1.5 list-disc list-inside">
                  <li><b className="text-rose-300">TTX 50%</b> + tək stimul → AP daralmış, amplituda azalır.</li>
                  <li><b className="text-rose-300">TTX 100%</b> → AP yox, sadəcə passiv depolarizasiya.</li>
                  <li><b className="text-sky-300">TEA 80%</b> → repolarizasiya yavaşlayır, AP uzanır.</li>
                  <li><b className="text-orange-300">T = 30°C</b> → AP 5 dəfə qısalır (Q₁₀).</li>
                  <li><b className="text-orange-300">T = 3°C</b> → AP genişlənir, kinetika yavaşlayır.</li>
                </ul>
              )}
              {mode === MODE.VC && (
                <ul className="space-y-1.5 list-disc list-inside">
                  <li>V_cmd = <b>−20 mV</b> → kiçik içəri Na⁺ axını.</li>
                  <li>V_cmd = <b>0 mV</b> → güclü içəri sonra çölə K⁺ axını (klassik kalmar izi).</li>
                  <li>V_cmd = <b>+50 mV</b> (E_Na) → Na⁺ axını yox olur (sürücü qüvvə = 0).</li>
                  <li><b className="text-rose-300">TTX</b> → yalnız çölə K⁺ axını qalır.</li>
                  <li><b className="text-sky-300">TEA</b> → yalnız içəri Na⁺ axını qalır (geri qayıdır).</li>
                </ul>
              )}
              {mode === MODE.SYN && (
                <ul className="space-y-1.5 list-disc list-inside">
                  <li><b>Tək EPSP:</b> g=0.3, tək AP → V₂ kiçik dalğa, eşik altı.</li>
                  <li><b>Sinaptik summasiya:</b> Qatar 100 Hz, g=0.3 → V₂-də EPSP-lər toplanır, AP yaranır.</li>
                  <li><b>Eşik gücü:</b> Tək AP, g-ni artır → kritik nöqtədə post AP-yə keçir.</li>
                  <li><b>İnhibisiya:</b> tipi inh-yə dəyiş → V₂ hiperpolarizasiya olur.</li>
                  <li><b>Yatğunluq:</b> Yüksək tezlikli qatarda EPSP-lər kiçilir.</li>
                </ul>
              )}
            </div>
          </div>
        </div>

        <footer className="mt-8 pt-4 border-t border-slate-800 text-xs text-slate-500" style={fontMono}>
          Cm = 1 µF/cm² · gNa = 120 · gK = 36 · gL = 0.3 mS/cm² · ENa = +50 · EK = −77 · EL = −54.4 mV · Q₁₀(qapı) = 3
        </footer>
      </div>
    </div>
  );
}

// Landing: editorial hero over a live Three.js "molten core" — a noise-displaced
// wireframe icosphere with an ember heart, dust field, and UnrealBloom. The scene
// reacts to the cursor (camera parallax + faster spin on hover of the CTA).
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { useStore } from "../state/store";

const NOISE_GLSL = `
vec3 mod289(vec3 x){return x - floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x - floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

export default function Landing() {
  const mountRef = useRef<HTMLDivElement>(null);
  const [leaving, setLeaving] = useState(false);

  const enter = () => {
    if (leaving) return;
    setLeaving(true);
    setTimeout(() => useStore.setState({ phase: "prejoin" }), 620);
  };

  useEffect(() => {
    const mount = mountRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x060606);
    scene.fog = new THREE.FogExp2(0x060606, 0.16);
    const camera = new THREE.PerspectiveCamera(42, mount.clientWidth / mount.clientHeight, 0.1, 60);
    camera.position.set(0, 0, 4.4);

    const group = new THREE.Group();
    scene.add(group);

    // ——— molten shell: noise-displaced wireframe icosphere ———
    const uniforms = {
      uTime: { value: 0 },
      uAmp: { value: 0.16 },
    };
    const shellMat = new THREE.ShaderMaterial({
      uniforms,
      wireframe: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      vertexShader: `
        uniform float uTime; uniform float uAmp;
        varying float vElev; varying vec3 vNorm; varying vec3 vView;
        ${NOISE_GLSL}
        void main() {
          vec3 dir = normalize(position);
          // slow-evolving field: high time multipliers read as on-screen flicker
          float n = snoise(dir * 2.1 + vec3(uTime * 0.045, uTime * 0.035, uTime * 0.03));
          float n2 = snoise(dir * 3.8 - vec3(uTime * 0.06)) * 0.25;
          float d = (n + n2) * uAmp;
          vec3 p = position + dir * d;
          vElev = n + n2;
          vNorm = normalize(normalMatrix * dir);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vView = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vElev; varying vec3 vNorm; varying vec3 vView;
        void main() {
          float fres = pow(1.0 - abs(dot(vNorm, vView)), 1.8);
          vec3 bone = vec3(0.93, 0.91, 0.87);
          vec3 ember = vec3(1.0, 0.36, 0.10);
          float heat = smoothstep(0.3, 1.1, vElev); // wide band: no hard bone/ember flip
          vec3 col = bone * (0.22 + fres * 0.55) + ember * heat * 1.1;
          // brighter per-line: detail 5 has far fewer additive overlaps than 7 did
          float a = 0.055 + fres * 0.38 + heat * 0.48;
          gl_FragColor = vec4(col, a);
        }`,
    });
    // detail 5: at 7 the edges are ~3px apart and the 1px lines moiré while rotating
    const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(1.24, 5), shellMat);
    group.add(shell);

    // ——— ember heart: additive radial sprite, breathing ———
    const glowCanvas = document.createElement("canvas");
    glowCanvas.width = glowCanvas.height = 128;
    const gctx = glowCanvas.getContext("2d")!;
    const grad = gctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, "rgba(255,150,70,0.95)");
    grad.addColorStop(0.22, "rgba(255,95,30,0.5)");
    grad.addColorStop(0.55, "rgba(255,70,20,0.12)");
    grad.addColorStop(1, "rgba(255,70,20,0)");
    gctx.fillStyle = grad;
    gctx.fillRect(0, 0, 128, 128);
    const glowTex = new THREE.CanvasTexture(glowCanvas);
    const heart = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })
    );
    heart.scale.setScalar(1.55);
    group.add(heart);

    // ——— dust field ———
    const N = 700;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const r = 2.3 + Math.random() * 2.6;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th) * 0.7;
      pos[i * 3 + 2] = r * Math.cos(ph);
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    // round soft dot texture so dust renders as circles, not squares
    const dotCanvas = document.createElement("canvas");
    dotCanvas.width = dotCanvas.height = 32;
    const dctx = dotCanvas.getContext("2d")!;
    const dgrad = dctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    dgrad.addColorStop(0, "rgba(255,255,255,1)");
    dgrad.addColorStop(0.4, "rgba(255,255,255,0.6)");
    dgrad.addColorStop(1, "rgba(255,255,255,0)");
    dctx.fillStyle = dgrad;
    dctx.fillRect(0, 0, 32, 32);
    const dotTex = new THREE.CanvasTexture(dotCanvas);
    const dust = new THREE.Points(
      dustGeo,
      new THREE.PointsMaterial({
        color: 0xeae6dd, size: 0.03, sizeAttenuation: true, map: dotTex, alphaTest: 0.01,
        transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    group.add(dust);

    // place the core right-of-center on wide screens
    const place = () => { group.position.x = mount.clientWidth > 900 ? 1.15 : 0; };
    place();

    // ——— bloom ———
    // EffectComposer renders offscreen, which bypasses the canvas MSAA — without a
    // multisampled target the wireframe aliases into shimmer while it spins.
    const rtarget = new THREE.WebGLRenderTarget(mount.clientWidth, mount.clientHeight, {
      type: THREE.HalfFloatType,
      samples: 4,
    });
    const composer = new EffectComposer(renderer, rtarget);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(mount.clientWidth, mount.clientHeight), 0.55, 0.5, 0.6);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    // ——— interaction ———
    const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
    const onMove = (e: PointerEvent) => {
      mouse.tx = (e.clientX / innerWidth) * 2 - 1;
      mouse.ty = -((e.clientY / innerHeight) * 2 - 1);
    };
    addEventListener("pointermove", onMove);

    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const clock = new THREE.Clock();
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const t = clock.getElapsedTime();
      uniforms.uTime.value = t;
      mouse.x += (mouse.tx - mouse.x) * 0.045;
      mouse.y += (mouse.ty - mouse.y) * 0.045;
      group.rotation.y = t * 0.08 + mouse.x * 0.25;
      group.rotation.x = Math.sin(t * 0.11) * 0.12 - mouse.y * 0.18;
      dust.rotation.y = -t * 0.02;
      heart.material.opacity = 0.62 + Math.sin(t * 0.9) * 0.05;
      heart.scale.setScalar(1.55 + Math.sin(t * 0.9) * 0.05);
      camera.position.x = mouse.x * 0.3;
      camera.position.y = mouse.y * 0.22;
      camera.lookAt(group.position.x * 0.6, 0, 0);
      composer.render();
    };
    if (reduced) {
      uniforms.uTime.value = 4;
      composer.render();
    } else {
      tick();
    }

    const onResize = () => {
      const w = mount.clientWidth, h = mount.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      composer.setSize(w, h);
      place();
    };
    addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      removeEventListener("pointermove", onMove);
      removeEventListener("resize", onResize);
      shell.geometry.dispose(); shellMat.dispose();
      dustGeo.dispose(); (dust.material as THREE.Material).dispose();
      glowTex.dispose(); dotTex.dispose(); heart.material.dispose();
      composer.dispose(); renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div id="landing" className={leaving ? "leaving" : ""}>
      <div className="webgl" ref={mountRef} />
      <div className="grain" />

      <nav className="land-nav">
        <span className="land-wordmark">forge<i>.</i></span>
        <span className="land-nav-note"><span className="live-dot" /> system online</span>
      </nav>

      <div className="land-hero">
        <p className="land-eyebrow">AI TEAMMATE — Nº 001</p>
        <h1 className="land-title">
          The engineer<br />
          <em>in the room.</em>
        </h1>
        <p className="land-sub">
          Forge sits in your call and listens. Ask it a question and it answers —
          sketching live architecture on a shared whiteboard while it speaks.
          It never interrupts. It raises its hand.
        </p>
        <div className="land-cta-row">
          <button className="land-enter" onClick={enter}>
            Enter the room <span className="arr">→</span>
          </button>
          <span className="land-hint">chrome · mic + cam</span>
        </div>
      </div>

      <footer className="land-foot">
        <span>P2P · WEBRTC</span>
        <span>REPO-AWARE</span>
        <span>RAISES ITS HAND</span>
      </footer>
    </div>
  );
}

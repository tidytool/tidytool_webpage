"use client";

/**
 * In-page 3D viewer for drawer scans (.usdz from iPhone LiDAR, .ply point
 * clouds). three.js is a deliberate, signed-off dependency — but it's heavy,
 * so it is dynamically imported only when a viewer actually mounts; the rest
 * of the admin bundle never pays for it. USD parsing in three is best-effort:
 * any load/parse failure degrades to a download link rather than an error wall.
 */
import { useEffect, useRef, useState } from "react";

export function ScanViewer({ url, label }: { url: string; label: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let raf = 0;
    let cleanup: (() => void) | null = null;

    (async () => {
      try {
        const THREE = await import("three");
        const { OrbitControls } = await import(
          "three/examples/jsm/controls/OrbitControls.js"
        );

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0xf7f8fa); // --c-bg

        // Load the model by extension.
        const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
        let object: import("three").Object3D;
        if (ext === "ply") {
          const { PLYLoader } = await import(
            "three/examples/jsm/loaders/PLYLoader.js"
          );
          const geometry = await new PLYLoader().loadAsync(url);
          if (geometry.index) {
            geometry.computeVertexNormals();
            object = new THREE.Mesh(
              geometry,
              new THREE.MeshStandardMaterial({
                color: 0x8899a6,
                vertexColors: geometry.hasAttribute("color"),
              }),
            );
          } else {
            object = new THREE.Points(
              geometry,
              new THREE.PointsMaterial({
                size: 0.002,
                vertexColors: geometry.hasAttribute("color"),
                color: geometry.hasAttribute("color") ? 0xffffff : 0x4a5860,
              }),
            );
          }
        } else {
          const { USDLoader } = await import(
            "three/examples/jsm/loaders/USDLoader.js"
          );
          object = await new USDLoader().loadAsync(url);
        }
        if (disposed) return;

        // Center the model and frame the camera on it.
        const box = new THREE.Box3().setFromObject(object);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        object.position.sub(center);
        scene.add(object);
        const radius = Math.max(size.x, size.y, size.z) || 1;

        const width = host.clientWidth || 600;
        const height = host.clientHeight || 380;
        const camera = new THREE.PerspectiveCamera(45, width / height, radius / 100, radius * 20);
        camera.position.set(radius * 0.9, radius * 0.9, radius * 1.2);

        scene.add(new THREE.AmbientLight(0xffffff, 1.1));
        const key = new THREE.DirectionalLight(0xffffff, 1.6);
        key.position.set(1, 2, 1.5);
        scene.add(key);

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(width, height);
        host.appendChild(renderer.domElement);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;

        const onResize = () => {
          const w = host.clientWidth;
          const h = host.clientHeight;
          if (!w || !h) return;
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h);
        };
        window.addEventListener("resize", onResize);

        const tick = () => {
          controls.update();
          renderer.render(scene, camera);
          raf = requestAnimationFrame(tick);
        };
        tick();
        setState("ready");

        cleanup = () => {
          cancelAnimationFrame(raf);
          window.removeEventListener("resize", onResize);
          controls.dispose();
          renderer.dispose();
          renderer.domElement.remove();
        };
      } catch {
        if (!disposed) setState("error");
      }
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [url]);

  if (state === "error") {
    return (
      <p className="muted" style={{ fontSize: "0.85rem", margin: "0.4rem 0 0" }}>
        Couldn&apos;t render this scan in the browser.{" "}
        <a href={url} download>
          Download the model file →
        </a>
      </p>
    );
  }

  return (
    <div className="qv__viewer" ref={hostRef} aria-label={`3D scan of ${label}`}>
      {state === "loading" ? <span className="qv__viewer-hint">Loading 3D scan…</span> : null}
    </div>
  );
}

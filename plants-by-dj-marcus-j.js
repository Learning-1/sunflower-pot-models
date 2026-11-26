(() => {
    "use strict";

    const flowers = {
        sunflower: "Sunflower", tulip: "Tulip", zinnia: "Zinnia",
        geranium: "Geranium", rose: "Rose", orchid: "Moth Orchid"
    };
    const potColors = {
        Terracotta: null, Green: "#387349", Black: "#25282A", White: "#F2F1E8"
    };
    const signatureColors = {
        fushia_hp: "#FF0088", bluemoon22: "#0000FF", inati: "#069494"
    };
    const assetBase = "https://learning-1.github.io/sunflower-pot-models/";
    const stateFile = "flower-garden-growth-v1";
    if (window.sunflowerGardenLoaded) return;
    window.sunflowerGardenLoaded = true;
    let writes = Promise.resolve();
    const stages = ["Bare soil", "Seed planted", "Sprout", "Leaves", "Bud", "Bloom"];
    const dayMs = 86400000;
    const soilTop = 0.255;
    const wateringTargets = new Map();
    let sharedCan;
    const nowMs = () => Date.now();
    const vec = values => new BS.Vector3(...values);
    const rgb = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
    const potNumber = id => "#" + id.replace(/^pot-/, "");
    function signatureColor(name) {
        const key = (name ?? "").toLowerCase();
        return Object.hasOwn(signatureColors, key) ? signatureColors[key] : null;
    }
    const canPoseFile = "flower-garden-can-placement-v1";
    const toolObservers = new Map();
    let stemTipsRequest;

    function validPose(pose) {
        return pose?.position?.length === 3 && pose.position.every(Number.isFinite) &&
            pose?.rotation?.length === 4 && pose.rotation.every(Number.isFinite);
    }

    async function applyPose(object, pose) {
        await object.SetLocalPosition(vec(pose.position));
        await object.SetLocalRotation(new BS.Quaternion(...pose.rotation));
    }

    function waterings(plant) {
        return plant.waterings ?? (plant.wateredAt === null ? 0 : 3);
    }

    function requiredWaterings(plant) {
        return plant.requiredWaterings === 2 ? 2 : 3;
    }

    function nextWateringAt(plant) {
        if (plant.wateredAt === null) return 0;
        const count = waterings(plant);
        const required = requiredWaterings(plant);
        return count >= required ? Infinity : plant.wateredAt + (plant.duration ?? 300000) * count / required;
    }

    function stageAt(plant, now) {
        if (!plant) return 0;
        if (plant.wateredAt === null) return 1;
        const progress = (now - plant.wateredAt) / (plant.duration ?? 300000);
        if (progress >= 1 && waterings(plant) >= requiredWaterings(plant)) return 5;
        if (progress >= 0.8 && waterings(plant) >= 2) return 4;
        if (progress >= 0.5) return 3;
        return progress >= 0.2 ? 2 : 1;
    }

    function validDesign(value) {
        return Number.isInteger(value) && value >= 0 && value < 4;
    }

    function readGarden(text) {
        if (text === null) return {};
        const record = JSON.parse(text);
        if (record?.version !== 2 || !record.pots || typeof record.pots !== "object" || Array.isArray(record.pots)) {
            throw new Error("Invalid sunflower garden save");
        }
        return record.pots;
    }

    function pickDesign(pots, species) {
        const active = Object.entries(pots)
            .filter(([id, plant]) => plant?.wateredAt && wateringTargets.get(id)?.species === species)
            .map(([, plant]) => plant);
        const options = [];
        for (let stem = 0; stem < 4; stem++) {
            for (let head = 0; head < 4; head++) {
                const used = active.some(plant => plant.stem === stem && plant.head === head);
                const repeats = active.reduce((total, plant) =>
                    total + Number(plant.stem === stem) + Number(plant.head === head), 0);
                options.push({ stem, head, score: 100 * Number(used) + repeats });
            }
        }
        const best = Math.min(...options.map(option => option.score));
        const pool = options.filter(option => option.score === best);
        const { stem, head } = pool[Math.floor(Math.random() * pool.length)];
        return { stem, head };
    }

    function updateGarden(storage, scene, id, action, duration, species, wateringGoal) {
        const operation = writes.then(async () => {
            if (!(await storage.info(scene)).canWrite) return false;
            const pots = readGarden(await storage.get(scene, stateFile));
            const plant = Object.hasOwn(pots, id) ? pots[id] : null;
            const now = nowMs();
            if (action === "plant" && !plant) pots[id] = { wateredAt: null };
            else if (action === "water" && plant?.wateredAt === null) {
                pots[id] = { wateredAt: now, waterings: 1, duration, requiredWaterings: wateringGoal, ...pickDesign(pots, species) };
            } else if (action === "water" && plant && now >= nextWateringAt(plant)) {
                pots[id] = { ...plant, waterings: waterings(plant) + 1 };
            } else if (action === "clear" && stageAt(plant, now) === 5) {
                delete pots[id];
            } else return false;
            await storage.set(scene, stateFile, JSON.stringify({ version: 2, pots }));
            return true;
        });
        writes = operation.catch(() => {});
        return operation;
    }

    async function mount(element, id, hostsCan, placement, onMoved, canOrigin) {
        const scene = BS.Scene.GetInstance();
        await scene.WaitForUnityLoaded();
        const storage = BS.PersistFileBridge;

        const species = Object.hasOwn(flowers, placement.species) ? placement.species : "sunflower";
        const flowerName = flowers[species];
        const colorForRose = /^#[a-f\d]{6}$/i.test(placement.roseColor ?? "") ? placement.roseColor : "#C41E39";
        const potColor = /^#[a-f\d]{6}$/i.test(placement.potColor ?? "") ? rgb(placement.potColor) : null;
        const modelBase = element.getAttribute("model-base") || assetBase;
        const requestedDays = Number(element.getAttribute("growth-days") ?? 14);
        const days = Number.isFinite(requestedDays) ? Math.min(14, Math.max(7, requestedDays)) : 14;
        const duration = days * dayMs;
        const wateringGoal = days === 7 ? 2 : 3;
        const position = element.getAttribute("position")?.trim().split(/\s+/).map(Number);
        const root = new BS.GameObject({
            name: flowerName + " Pot " + potNumber(id),
            localPosition: vec(placement?.position || (position?.length === 3 && position.every(Number.isFinite) ? position : [0, 0, 2]))
        });
        await root.Async();
        if (placement?.rotation) await root.SetLocalRotation(new BS.Quaternion(...placement.rotation));
        const canRoot = hostsCan ? new BS.GameObject({ name: "Shared can base", localPosition: vec(canOrigin) }) : null;
        if (canRoot) await canRoot.Async();

        async function shape(parent, title, geometry, xyz, rgb, scale = [1, 1, 1], angle = [0, 0, 0]) {
            const object = new BS.GameObject({
                name: title, parent, localPosition: vec(xyz), localScale: vec(scale), localEulerAngles: vec(angle)
            });
            await object.AddComponent(geometry);
            await object.AddComponent(new BS.Material({ color: new BS.Vector4(...rgb, 1) }));
            return object;
        }
        const cylinder = (top, bottom, height, sides = 20) =>
            new BS.Cylinder({ radiusTop: top, radiusBottom: bottom, height, radialSegments: sides });
        const sphere = () => new BS.Sphere({ radius: 1, widthSegments: 10, heightSegments: 6 });
        await shape(root, "Flower pot", cylinder(0.19, 0.13, 0.25), [0, 0.125, 0], potColor ?? [0.58, 0.22, 0.12]);
        await shape(root, "Pot lip", new BS.Torus({ radius: 0.198, tube: 0.011, radialSegments: 6, tubularSegments: 20 }),
            [0, 0.258, 0], potColor ? potColor.map(channel => channel * 0.9 + 0.1) : [0.73, 0.32, 0.18], [1, 1, 1], [90, 0, 0]);
        await shape(root, "Visible soil", cylinder(0.177, 0.177, 0.012), [0, soilTop - 0.006, 0], [0.19, 0.105, 0.056]);

        await shape(root, "Plant tag stake", new BS.Box({ width: 0.011, height: 0.112, depth: 0.009 }),
            [0.086, 0.292, -0.115], [0.33, 0.26, 0.16]);
        const panelObject = new BS.GameObject({
            name: "Staked plant tag", parent: root,
            localPosition: vec([0.086, 0.344, -0.122]), localScale: vec([0.048, 0.048, 0.048])
        });
        const panel = await panelObject.AddComponent(new BS.UIPanel({ resolution: new BS.Vector2(320, 130) }));
        panel.SetBackgroundColor(new BS.Vector4(0.04, 0.09, 0.06, 1));
        const layout = new BS.UIVisualElement(panel);
        layout.SetStyles({ paddingTop: 8, paddingLeft: 12, paddingRight: 12 });
        const tag = new BS.UILabel(panel, layout);
        tag.text = potNumber(id) + " " + flowerName;
        tag.SetStyles({ color: "#F5E8C9", fontSize: 23, height: 28 });
        const status = new BS.UILabel(panel, layout);
        status.SetStyles({ color: "#E9F5DE", fontSize: 27 });
        status.text = "Loading…";

        let plant = null;
        let visibleModel;
        let model;
        let owner = false;
        let button;
        let busy = false;
        let refreshTask;
        let closed = false;
        let errorMessage = "";
        let seed, can;
        let toolsReady = false;
        const toolAccess = new Map();
        const disposeTools = [];
        const recoverTool = new Map();
        let canHeld = false;
        let canTimer;

        async function positionOf(object) {
            const transform = await object.GetComponentAsync(BS.Unity.Transform);
            return transform.GetPosition();
        }

        function overSoil(point, center, maxHeight) {
            const height = point.y - center.y - soilTop;
            return Math.hypot(point.x - center.x, point.z - center.z) <= 0.161
                && height >= -0.025 && height <= maxHeight;
        }

        async function makeTool(title, home, geometry, color, size, grab, drop, colliderCenter = [0, 0, 0], parent = root, movable = false) {
            const object = await shape(parent, title, geometry, home, color);
            await object.AddComponent(new BS.BoxCollider({ size: vec(size), center: vec(colliderCenter) }));
            const collider = await object.GetComponentAsync(BS.Unity.BoxCollider);
            await collider.SetEnabled(false);
            await object.AddComponent(new BS.Rigidbody({ mass: 0.25, useGravity: false, drag: 8, angularDrag: 8 }));
            await object.AddComponent(new BS.Grababble({ grabType: BS.BSGrabType.Soft }));
            const body = await object.GetComponentAsync(BS.Unity.Rigidbody);
            const transform = await object.GetComponentAsync(BS.Unity.Transform);
            const key = "sunflower-tool-v1-" + (movable ? "can" : id);
            let rest = { position: home, rotation: [0, 0, 0, 1] };
            let held = false;
            let releasing = false;
            let transmission;
            let motionTimer;
            let receivedUntil = 0;
            let remotePose;
            let dirty = true;
            let enabled = false;
            let syncWarning = false;
            async function sample() {
                const [point, rotation] = await Promise.all([transform.GetLocalPosition(), transform.GetLocalRotation()]);
                return { position: [point.x, point.y, point.z],
                    rotation: [rotation.x, rotation.y, rotation.z, rotation.w] };
            }
            async function publish(pose, placed = false) {
                try {
                    await scene.SpaceStateSet(key, JSON.stringify({ pose, placed, expires: Date.now() + 3200 }), { protected: true });
                } catch (error) {
                    if (!syncWarning) console.warn("[Sunflower Garden] Tool sync unavailable", error);
                    syncWarning = true;
                }
            }
            function receive(value) {
                if (owner || closed) return;
                try {
                    const packet = value == null ? null : JSON.parse(value);
                    receivedUntil = Math.min(Date.now() + 3200, Number(packet?.expires) || 0);
                    const activePacket = receivedUntil > Date.now() && validPose(packet?.pose);
                    if (activePacket && movable && packet.placed) rest = packet.pose;
                    remotePose = activePacket && !packet.placed ? packet.pose : null;
                    dirty = true;
                    void renderRemote().catch(error => console.warn("[Sunflower Garden] Tool pose unavailable", error));
                    if (!movable && packet?.pose === null && receivedUntil > Date.now()) void refresh();
                } catch (error) {
                    console.warn("[Sunflower Garden] Invalid tool pose", error);
                }
            }
            let rendering = false;
            async function renderRemote() {
                if (owner || closed || rendering) return;
                rendering = true;
                try {
                    while (dirty && !owner && !closed) {
                        dirty = false;
                        await applyPose(object, remotePose && Date.now() < receivedUntil ? remotePose : rest);
                    }
                } finally {
                    rendering = false;
                }
            }
            toolObservers.set(key, receive);
            disposeTools.push({ movable, dispose: () => {
                clearInterval(motionTimer);
                toolObservers.delete(key);
            } });
            async function reset() {
                if (closed || held) return;
                await body.SetLinearVelocity(vec([0, 0, 0]));
                await body.SetAngularVelocity(vec([0, 0, 0]));
                if (closed || held) return;
                await applyPose(object, rest);
            }
            recoverTool.set(object, async () => {
                if (held || releasing) return;
                if (movable) {
                    const saved = await storage.get(scene, canPoseFile);
                    const next = saved ? JSON.parse(saved) : null;
                    if (validPose(next) && JSON.stringify(rest) !== JSON.stringify(next)) {
                        rest = next;
                        dirty = true;
                    }
                }
                if (!owner) {
                    if (remotePose && Date.now() >= receivedUntil) { remotePose = null; dirty = true; }
                    await renderRemote();
                } else {
                    const current = await sample();
                    const distance = Math.hypot(...current.position.map((axis, i) => axis - rest.position[i]));
                    const alignment = Math.abs(current.rotation.reduce((sum, axis, i) => sum + axis * rest.rotation[i], 0));
                    if (distance > 0.035 || alignment < 0.999) await reset();
                }
            });
            toolAccess.set(object, async allowed => {
                if (enabled === allowed) return;
                enabled = allowed;
                await collider.SetEnabled(allowed);
            });
            object.addEventListener("grab", () => {
                if (!owner || held || releasing) return;
                held = true;
                grab();
                const tick = () => {
                    if (transmission || !held || !owner || closed) return;
                    transmission = sample().then(pose => {
                        if (held && owner && validPose(pose)) return publish(pose);
                    }).catch(error => console.warn("[Sunflower Garden] Sampling tool pose failed", error))
                        .finally(() => { transmission = null; });
                };
                void tick();
                motionTimer = setInterval(tick, 140);
            });
            object.addEventListener("drop", () => void (async () => {
                if (!held || releasing) return;
                held = false;
                releasing = true;
                clearInterval(motionTimer);
                try {
                    if (owner) {
                        await drop(object);
                        if (movable && (await storage.info(scene)).canWrite === true) {
                            const pose = await sample();
                            if (validPose(pose)) {
                                await storage.set(scene, canPoseFile, JSON.stringify(pose));
                                rest = pose;
                            }
                        }
                    }
                } finally {
                    try {
                        await reset();
                    } finally {
                        releasing = false;
                    }
                    void Promise.resolve(transmission).then(() => {
                        if (owner && !held && !releasing && !closed) return publish(movable ? rest : null, movable);
                    });
                }
            })().catch(error => console.warn("[Sunflower Pot] Tool release failed", error)));
            if (!owner) {
                await recoverTool.get(object)();
                void scene.SpaceStateGet(key).then(receive).catch(() => {});
            }
            return object;
        }

        const canHome = [0.45, 0.13, 0];
        const canColor = [0.18, 0.20, 0.18];
        const canGrip = [0.151, 0.054, 0];
        const canBody = () => cylinder(0.078, 0.094, 0.178, 18);

        async function addCanDetails(object) {
            const spoutAngle = [0, 0, 51];
            await Promise.all([
                shape(object, "Loop handle", new BS.Torus({ radius: 0.093, tube: 0.014 }),
                    [0.073, 0.052, 0], canColor, [1, 1.3, 1]),
                shape(object, "Top rim", cylinder(0.083, 0.083, 0.014, 18),
                    [0, 0.087, 0], [0.22, 0.24, 0.22]),
                shape(object, "Fill opening", cylinder(0.058, 0.058, 0.006, 18),
                    [0, 0.096, 0], [0.065, 0.075, 0.066]),
                shape(object, "Base band", cylinder(0.095, 0.092, 0.019, 18),
                    [0, -0.083, 0], [0.13, 0.15, 0.13]),
                shape(object, "Tapered spout", cylinder(0.018, 0.031, 0.195, 12),
                    [-0.146, 0.02, 0], canColor, [1, 1, 1], spoutAngle),
                shape(object, "Sprinkler head", cylinder(0.046, 0.020, 0.029, 16),
                    [-0.228, 0.09, 0], canColor, [1, 1, 1], spoutAngle)
            ]);
            return shape(object, "Sprinkler face", cylinder(0.042, 0.043, 0.007, 16),
                [-0.242, 0.101, 0], [0.39, 0.42, 0.39], [1, 1, 1], spoutAngle);
        }

        async function setupTools() {
            let seedHeld = false;
            seed = await makeTool("Sunflower seed", [-0.29, 0.13, 0],
                new BS.Sphere({ radius: 0.044, widthSegments: 10, heightSegments: 6 }), [0.16, 0.085, 0.045],
                [0.10, 0.10, 0.10], () => { seedHeld = true; }, async object => {
                    if (!seedHeld) return;
                    seedHeld = false;
                    const [point, center] = await Promise.all([positionOf(object), positionOf(root)]);
                    if (overSoil(point, center, 0.30)) await refresh("plant");
                });
            if (!hostsCan) return;
            let outlet;
            let particleRoot;
            let particles = [];
            let particlesVisible = false;
            let checking = false;
            let targetSince = null;
            let targetId;
            async function stopParticles() {
                if (!particlesVisible) return;
                particlesVisible = false;
                await particleRoot.SetActive(false);
            }
            async function pour(tip, center, target) {
                const fall = target ? Math.max(0.02, tip.y - target.center.y - soilTop) : 0.52;
                await Promise.all(particles.map(async (jet, index) => {
                    const angle = (index - 1) * Math.PI / 3;
                    const radius = index === 0 ? 0 : 0.024;
                    const spread = index === 0 ? 0 : fall * 0.19;
                    const dx = Math.cos(angle) * spread;
                    const dz = Math.sin(angle) * spread;
                    const degrees = 180 / Math.PI;
                    const pitch = -Math.atan2(dz, fall) * degrees;
                    const roll = Math.atan2(dx, Math.hypot(fall, dz)) * degrees;
                    await Promise.all([
                        jet.SetLocalPosition(vec([
                            tip.x - center.x + Math.cos(angle) * radius + dx / 2,
                            tip.y - center.y - fall / 2,
                            tip.z - center.z + Math.sin(angle) * radius + dz / 2
                        ])),
                        jet.SetLocalEulerAngles(vec([pitch, 0, roll])),
                        jet.SetLocalScale(vec([1, Math.hypot(fall, dx, dz), 1]))
                    ]);
                }));
                if (!particlesVisible && canHeld) {
                    particlesVisible = true;
                    await particleRoot.SetActive(true);
                }
            }
            can = await makeTool("Watering can", canHome, canBody(),
                canColor, [0.046, 0.11, 0.052], () => {
                    if (canHeld || !owner) return;
                    canHeld = true;
                    targetId = null;
                    canTimer = setInterval(async () => {
                        if (checking || closed || !canHeld) return;
                        checking = true;
                        try {
                            const [tip, body, center] = await Promise.all([positionOf(outlet), positionOf(can), positionOf(canRoot)]);
                            if (!canHeld || tip.y >= body.y - 0.035) {
                                targetId = null;
                                targetSince = null;
                                await stopParticles();
                                return;
                            }
                            const now = performance.now();
                            const targets = await Promise.all([...wateringTargets.values()].map(async pot =>
                                ({ ...pot, center: await positionOf(pot.root) })));
                            const target = targets.filter(pot => overSoil(tip, pot.center, 0.42))
                                .sort((a, b) => Math.hypot(tip.x - a.center.x, tip.z - a.center.z) -
                                    Math.hypot(tip.x - b.center.x, tip.z - b.center.z))[0];
                            await pour(tip, center, target);
                            if (targetId !== target?.id) {
                                targetId = target?.id;
                                targetSince = target ? now : null;
                            }
                            if (target && targetSince !== null && now - targetSince >= 260) {
                                targetSince = null;
                                await target.refresh("water");
                            }
                        } catch (error) {
                            clearInterval(canTimer);
                            await stopParticles();
                            console.warn("[Sunflower Pot] Pour check failed", error);
                        } finally {
                            checking = false;
                        }
                    }, 95);
                }, async () => {
                    canHeld = false;
                    targetSince = null;
                    clearInterval(canTimer);
                    await stopParticles();
                }, canGrip, canRoot, true);
            outlet = await addCanDetails(can);
            sharedCan = can;
            particleRoot = new BS.GameObject({ name: "Water particle pool", parent: canRoot, active: false });
            await particleRoot.Async();
            particles = await Promise.all(Array.from({ length: 7 }, (_, index) =>
                shape(particleRoot, "Water jet " + (index + 1), cylinder(0.003, 0.003, 1, 6), [0, 0, 0],
                    [0.59, 0.79, 0.88])));
        }

        async function renderStage(stage) {
            const stem = validDesign(plant?.stem) ? plant.stem : 0;
            const headDesign = validDesign(plant?.head) ? plant.head : 0;
            const modelKey = stage + ":" + stem + ":" + headDesign;
            if (visibleModel === modelKey) return;
            const next = new BS.GameObject({ name: stages[stage], parent: root, active: false });
            await next.Async();
            try {
                if (stage === 1) {
                    await shape(next, "Planted seed", sphere(), [0, soilTop, 0],
                        [0.62, 0.38, 0.17], [0.026, 0.009, 0.016]);
                }
                if (stage >= 2 && modelBase) {
                    const phase = stages[stage].toLowerCase();
                    const base = new URL(modelBase, location.href);
                    async function botanicalModel(file, position, label) {
                        const object = new BS.GameObject({
                            name: label, parent: next,
                            localPosition: vec(position), localEulerAngles: vec([0, 180, 0])
                        });
                        await object.AddComponent(new BS.GLTF({
                            url: new URL(file + ".glb", base).href, addColliders: false
                        }));
                    }
                    if (species === "sunflower") {
                        const variant = phase + "-" + stem + (stage === 5 ? "-" + headDesign : "");
                        await botanicalModel((stage >= 4 ? "sunflower-v2-" : "sunflower-test-") + variant, [0, soilTop, 0], phase);
                    } else {
                        const folder = "garden-";
                        const stemFile = species + "-" + phase + "-stem-" + stem;
                        let headFile;
                        let headPosition;
                        if (stage >= 4) {
                            stemTipsRequest ??= fetch(new URL(folder + "stem-tips.json", base)).then(response => {
                                if (!response.ok) throw new Error("Stem placement manifest unavailable");
                                return response.json();
                            }).catch(error => { stemTipsRequest = null; throw error; });
                            const [x, y, z] = (await stemTipsRequest)[stemFile];
                            const suffix = species === "rose" ? "-" + colorForRose.slice(1).toLowerCase() : "";
                            const design = stage === 5 ? headDesign : 0;
                            headFile = species + "-" + phase + "-head-" + design + suffix;
                            headPosition = [x, soilTop + y, z];
                        }
                        const models = [botanicalModel(folder + stemFile, [0, soilTop, 0], "Stem " + stem)];
                        if (headFile) models.push(botanicalModel(folder + headFile, headPosition, "Flower head"));
                        await Promise.all(models);
                    }
                } else if (stage >= 2) {
                    const height = [0, 0, 0.10, 0.24, 0.37, 0.46][stage];
                    const green = [0.21, 0.47, 0.12];
                    await shape(next, "Stem", cylinder(0.012, 0.016, height, 10),
                        [0, soilTop + height / 2, 0], green);
                    for (const side of [-1, 1]) {
                        await shape(next, "Leaf", sphere(), [side * height * 0.19, soilTop + height * 0.54, 0],
                            [0.31, 0.63, 0.13], [height * 0.29, height * 0.09, height * 0.12], [0, 0, side * 24]);
                    }
                    const head = soilTop + height;
                    if (stage === 4) {
                        await shape(next, "Closed bud", sphere(), [0, head, 0], green, [0.038, 0.052, 0.035]);
                    }
                    if (stage === 5) {
                        for (let index = 0; index < 12; index++) {
                            const angle = index * Math.PI / 6;
                            await shape(next, "Petal", sphere(),
                                [0.082 * Math.cos(angle), head + 0.082 * Math.sin(angle), -0.009],
                                [1, 0.69, 0.04], [0.053, 0.021, 0.013], [0, 0, index * 30]);
                        }
                        await shape(next, "Sunflower center", sphere(), [0, head, -0.024],
                            [0.32, 0.15, 0.053], [0.062, 0.062, 0.028]);
                    }
                }
                await next.SetActive(true);
            } catch (error) {
                await next.Destroy();
                throw error;
            }
            if (model) await model.Destroy();
            model = next;
            visibleModel = modelKey;
        }

        function updatePanel(stage) {
            let message = stages[stage];
            if (owner && !plant) message = "Drop seed in soil";
            if (plant && stage < 5) {
                const seconds = Math.ceil((nextWateringAt(plant) - nowMs()) / 1000);
                if (seconds <= 0) message = owner ? "Water now" : message + " · needs water";
                else if (Number.isFinite(seconds)) {
                    const remaining = seconds >= 86400 ? Math.ceil(seconds / 86400) + "d" :
                        seconds >= 3600 ? Math.ceil(seconds / 3600) + "h" :
                            seconds >= 120 ? Math.ceil(seconds / 60) + "m" : seconds + "s";
                    message = (stage === 1 ? "Watered" : message) + " · water in " + remaining;
                } else if (stage === 1 && plant.wateredAt !== null) message = "Watered";
            }
            status.text = errorMessage || message;
            if (!button) return;
            button.text = "Clear bloom";
            button.visible = owner && stage === 5;
            button.enabled = button.visible && !busy;
        }

        function refresh(action = null) {
            if (closed) return Promise.resolve(false);
            if (refreshTask) {
                return action ? refreshTask.then(() => refresh(action)) : refreshTask;
            }
            refreshTask = refreshNow(action).finally(() => { refreshTask = null; });
            return refreshTask;
        }

        let removed = false;
        async function refreshNow(action) {
            busy = true;
            if (button) button.enabled = false;
            let changed = false;
            try {
                owner = (await storage.info(scene)).canWrite === true;
                if (!toolsReady) {
                    await setupTools();
                    toolsReady = true;
                }
                if (can) {
                    await toolAccess.get(can)(owner);
                    await recoverTool.get(can)();
                }
                if (removed) {
                    return false;
                }
                if (owner && !button) {
                    button = new BS.UIButton(panel, layout);
                    button.SetStyles({ fontSize: 20, height: 42, color: "#162717", backgroundColor: "#CDE6A7" });
                    button.OnClick(() => void refresh("clear"));
                }
                if (action && owner) changed = await updateGarden(storage, scene, id, action, duration, species, wateringGoal);
                const pots = readGarden(await storage.get(scene, stateFile));
                plant = Object.hasOwn(pots, id) ? pots[id] : null;
                errorMessage = "";
                await renderStage(stageAt(plant, nowMs()));
                if (!plant) await recoverTool.get(seed)();
                await toolAccess.get(seed)(owner && !plant);
                await seed.SetActive(!plant);
            } catch (error) {
                if (!errorMessage || action) console.warn("[Sunflower Pot]", error);
                errorMessage = action ? "Change failed · try again" : "Garden data unavailable";
            } finally {
                busy = false;
                if (!removed) updatePanel(stageAt(plant, nowMs()));
            }
            return changed;
        }

        if (!storage) {
            status.text = "World storage unavailable";
            return;
        }
        const mover = await makeMover(root, [0.42, 0.25, 0.42], [0, 0.125, 0], onMoved);
        wateringTargets.set(id, { id, root, refresh, species });
        void refresh();
        const timer = setInterval(refresh, 5000);
        window.addEventListener("pagehide", () => {
            closed = true;
            for (const tool of disposeTools) tool.dispose();
            wateringTargets.delete(id);
            clearInterval(timer);
            clearInterval(canTimer);
        }, { once: true });
        return {
            id, root, mover,
            getPlant: () => plant,
            remove() {
                removed = true;
                for (const tool of disposeTools) if (!tool.movable) tool.dispose();
                wateringTargets.delete(id);
                root.Destroy();
                if (!hostsCan) {
                    closed = true;
                    clearInterval(timer);
                }
            }
        };
    }

    async function makeMover(object, size, center, savePose) {
        const transform = await object.GetComponentAsync(BS.Unity.Transform);
        await object.AddComponent(new BS.BoxCollider({ size: vec(size), center: vec(center), isTrigger: true }));
        const collider = await object.GetComponentAsync(BS.Unity.BoxCollider);
        await collider.SetEnabled(false);
        await object.AddComponent(new BS.Rigidbody({
            useGravity: false, drag: 12, angularDrag: 12, freezeRotationX: true, freezeRotationZ: true
        }));
        await object.AddComponent(new BS.Grababble({ grabType: BS.BSGrabType.Soft }));
        const body = await object.GetComponentAsync(BS.Unity.Rigidbody);
        let enabled = false;
        let held = false;
        object.addEventListener("grab", () => { held = enabled; });
        object.addEventListener("drop", async () => {
            if (!held) return;
            try {
                await body.SetLinearVelocity(vec([0, 0, 0]));
                await body.SetAngularVelocity(vec([0, 0, 0]));
                const [position, rotation] = await Promise.all([transform.GetPosition(), transform.GetRotation()]);
                await savePose({
                    position: [position.x, position.y, position.z],
                    rotation: [rotation.x, rotation.y, rotation.z, rotation.w]
                });
            } catch (error) {
                console.warn("[Sunflower Garden] Placement save failed", error);
            } finally {
                held = false;
            }
        });
        return {
            get held() { return held; },
            async enable(value) {
                enabled = value;
                await collider.SetEnabled(value);
            },
            async apply(pose) {
                await object.SetLocalPosition(vec(pose.position));
                if (pose.rotation) await object.SetLocalRotation(new BS.Quaternion(...pose.rotation));
            }
        };
    }

    window.addEventListener("bs-loaded", async () => {
        const scene = BS.Scene.GetInstance();
        await scene.WaitForUnityLoaded();
        const storage = BS.PersistFileBridge;
        const filename = "flower-garden-layout-v1";
        const elements = [...document.querySelectorAll('bs-snippet[name="plants-by-dj-marcus-j"]')];
        if (!elements.length) return;

        const first = elements[0];
        scene.On("space-state", event => {
            for (const change of event.detail.changes) {
                if (change.scope === "protected") toolObservers.get(change.path)?.(change.deleted ? null : change.value);
            }
        });
        function readPosition(attribute, fallback) {
            const position = first.getAttribute(attribute)?.trim().split(/\s+/).map(Number);
            return position?.length === 3 && position.every(Number.isFinite) ? position : fallback;
        }
        const framePosition = readPosition("position", [0, 1.24, 2]);
        const [frameX, frameY, frameZ] = framePosition;
        const canOrigin = readPosition("can-origin", [frameX - 1.2, frameY - 1.24, frameZ - 0.8]);
        const defaults = {
            nextId: 1, growthDays: 14,
            frame: { position: framePosition }, pots: {}
        };
        const pots = new Map();
        let layout = defaults;
        let owner = false;
        let mode = "locked";
        let notice = "";
        let selected;
        let confirmRemove;
        let flowerChoice = 0;
        let potChoice = 0;
        const speciesChoices = Object.keys(flowers);
        function availableColors() {
            const choices = Object.entries(potColors);
            const special = signatureColor(scene.localUser?.name);
            if (owner && special) choices.push(["Signature", special]);
            return choices;
        }
        function roseColor() {
            return signatureColor(scene.localUser?.name) ?? "#C41E39";
        }
        let pending = Promise.resolve();

        const frame = new BS.GameObject({ name: "Sunflower garden photo frame" });
        await frame.Async();
        const trim = new BS.GameObject({
            name: "Antique gold moulding", parent: frame, localPosition: vec([0, 0, 0.011])
        });
        await trim.AddComponent(new BS.Box({ width: 0.65, height: 0.57, depth: 0.039 }));
        await trim.AddComponent(new BS.Material({ color: new BS.Vector4(0.34, 0.17, 0.045, 1) }));
        const face = new BS.GameObject({
            name: "Carved gold frame face", parent: frame, localPosition: vec([0, 0, -0.011])
        });
        await face.AddComponent(new BS.Plane({ width: 0.65, height: 0.57 }));
        await face.AddComponent(new BS.Material({
            texture: new URL("sunflower-gold-trim-v9.png", assetBase).href,
            color: new BS.Vector4(1, 1, 1, 1), side: 2, generateMipMaps: true
        }));
        const screen = new BS.GameObject({
            name: "Garden owner controls", parent: frame, localPosition: vec([0, 0, -0.014]),
            localScale: vec([0.107, 0.107, 0.107])
        });
        const panel = await screen.AddComponent(new BS.UIPanel({ resolution: new BS.Vector2(420, 395) }));
        panel.SetBackgroundColor(new BS.Vector4(0.045, 0.085, 0.057, 1));
        const content = new BS.UIVisualElement(panel);
        content.SetStyles({ paddingTop: 8, paddingLeft: 10, paddingRight: 10 });
        function label(text, fontSize, height) {
            const result = new BS.UILabel(panel, content);
            result.text = text;
            result.SetStyles({ color: "#F0F6E9", fontSize, height });
            return result;
        }
        label("FLOWER GARDEN", 24, 29);
        const summary = label("", 17, 25);
        const message = label("", 16, 22);
        function button(text, action) {
            const control = new BS.UIButton(panel, content);
            control.text = text;
            control.SetStyles({
                fontSize: 17, height: 28, marginBottom: 2, color: "#F5E8C9", backgroundColor: "#304935"
            });
            control.OnClick(() => void run(action).catch(() => {}));
            return control;
        }
        const flowerPicker = button("Flower: Sunflower", () => {
            flowerChoice = (flowerChoice + 1) % speciesChoices.length;
        });
        const colorPicker = button("Pot color: Terracotta", () => {
            potChoice = (potChoice + 1) % availableColors().length;
        });
        const add = button("Add Flower Pot", () => mutate(next => {
            if (Object.keys(next.pots).length >= 8) { notice = "Garden is full (8 pots)"; return false; }
            const [x, , z] = next.frame.position;
            const floor = canOrigin[1];
            const existing = Object.values(next.pots);
            const position = [0.48, -0.48, 1.02, -1.02].map(offset => [x + offset, floor, z - 0.15])
                .find(candidate => existing.every(pot =>
                    Math.hypot(...pot.position.map((value, i) => value - candidate[i])) >= 0.45));
            if (!position) {
                notice = "Move a pot to free up space";
                return false;
            }
            selected = "pot-" + next.nextId++;
            const species = speciesChoices[flowerChoice];
            const [, potColor] = availableColors()[potChoice] ?? availableColors()[0];
            next.pots[selected] = { position, growthDays: next.growthDays === 7 ? 7 : 14, species, potColor };
            if (species === "rose") next.pots[selected].roseColor = roseColor();
            notice = potNumber(selected) + " " + flowers[species] + " added";
            return true;
        }));
        const arrange = button("Arrange Flower Pot", async () => {
            if (frameMover.held || [...pots.values()].some(pot => pot.mover.held)) {
                notice = "Set the item down first";
                return;
            }
            mode = mode === "pots" ? "locked" : "pots";
        });
        const placeFrame = button("Move Frame", async () => {
            if (frameMover.held || [...pots.values()].some(pot => pot.mover.held)) {
                notice = "Set the item down first";
                return;
            }
            mode = mode === "frame" ? "locked" : "frame";
        });
        const select = button("Select next pot", () => {
            const ids = Object.keys(layout.pots);
            selected = ids[(ids.indexOf(selected) + 1) % ids.length];
            confirmRemove = null;
        });
        const remove = button("Remove selected pot", async () => {
            const pot = pots.get(selected);
            if (!pot || pot.mover.held) return;
            if (pot.getPlant() && confirmRemove !== selected) {
                confirmRemove = selected;
                notice = "Press Confirm Remove to remove this plant";
                return;
            }
            const id = selected;
            await mutate(next => {
                delete next.pots[id];
                notice = "Pot " + potNumber(id) + " removed";
                return true;
            });
            confirmRemove = null;
        });
        const cycle = button("Cycle: 2 weeks · 3 waters", () => mutate(next => {
            next.growthDays = next.growthDays === 7 ? 14 : 7;
            return true;
        }));

        const frameMover = await makeMover(frame, [0.65, 0.57, 0.11], [0, 0, 0],
            pose => run(() => mutate(next => { next.frame = pose; return true; })));

        async function mutate(change) {
            if (!(await storage.info(scene)).canWrite) return;
            const next = structuredClone(layout);
            if (!change(next)) return;
            await storage.set(scene, filename, JSON.stringify(next));
            layout = next;
        }

        async function sync() {
            owner = (await storage.info(scene)).canWrite === true;
            if (!owner) mode = "locked";
            const text = await storage.get(scene, filename);
            layout = text ? JSON.parse(text) : defaults;
            for (const [id, pot] of pots) {
                if (!Object.hasOwn(layout.pots, id)) {
                    pot.remove();
                    pots.delete(id);
                }
            }
            for (const [id, pose] of Object.entries(layout.pots)) {
                if (!pots.has(id)) {
                    const attributes = {
                        "model-base": first.getAttribute("model-base"), "growth-days": String(pose.growthDays)
                    };
                    const pot = await mount({ getAttribute: name => attributes[name] ?? null }, id,
                        !sharedCan && id === Object.keys(layout.pots)[0], pose,
                        updated => run(() => mutate(next => {
                            if (!next.pots[id]) return false;
                            Object.assign(next.pots[id], updated);
                            return true;
                        })), canOrigin);
                    pots.set(id, pot);
                }
                const pot = pots.get(id);
                if (!pot.mover.held) await pot.mover.apply(pose);
                await pot.mover.enable(owner && mode === "pots");
            }
            if (!frameMover.held) await frameMover.apply(layout.frame);
            await frameMover.enable(owner && mode === "frame");
            if (!Object.hasOwn(layout.pots, selected)) selected = Object.keys(layout.pots)[0];
            const current = pots.get(selected)?.getPlant();
            const now = nowMs();
            const remaining = current ? nextWateringAt(current) - now : Infinity;
            const chosenFlower = flowers[layout.pots[selected]?.species] ?? flowers.sunflower;
            summary.text = selected ? potNumber(selected) + " " + chosenFlower + " · " +
                stages[stageAt(current, now)] : "No pots yet";
            const wateringStatus = Number.isFinite(remaining)
                ? remaining <= 0 ? "Water now" : "Next watering in " +
                    (remaining >= dayMs ? Math.ceil(remaining / dayMs) + " d" :
                        remaining >= 120000 ? Math.ceil(remaining / 60000) + " min" : Math.ceil(remaining / 1000) + " sec")
                : "";
            message.text = notice || wateringStatus;
            cycle.text = layout.growthDays === 7 ? "Cycle: 1 week · 2 waters" : "Cycle: 2 weeks · 3 waters";
            const species = speciesChoices[flowerChoice];
            const [colorName, color] = availableColors()[potChoice] ?? availableColors()[0];
            flowerPicker.text = "Flower: " + flowers[species] + (species === "rose" ? " (" + roseColor() + ")" : "");
            colorPicker.text = "Pot color: " + colorName + (colorName === "Signature" ? " (" + color + ")" : "");
            arrange.text = mode === "pots" ? "Finish Arranging" : "Arrange Flower Pot";
            placeFrame.text = mode === "frame" ? "Set Frame in Place" : "Move Frame";
            remove.text = confirmRemove === selected && selected ? "Confirm Remove" : "Remove selected pot";
            for (const control of [flowerPicker, colorPicker, add, arrange, placeFrame, select, remove, cycle]) control.visible = owner;
        }

        function run(action) {
            const result = pending.then(async () => {
                if (action && (await storage.info(scene)).canWrite) {
                    notice = "";
                    await action();
                }
                await sync();
            });
            pending = result.catch(error => {
                message.text = "Garden update failed";
                console.warn("[Sunflower Garden]", error);
            });
            return result;
        }

        if (!storage) { message.text = "World storage unavailable"; return; }
        await run();
        const interval = setInterval(() => void run().catch(() => {}), 2000);
        window.addEventListener("pagehide", () => clearInterval(interval), { once: true });
    }, { once: true });
})();

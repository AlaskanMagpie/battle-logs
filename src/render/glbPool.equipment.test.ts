import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { findEquipmentAttachmentTarget } from "./glbPool";

describe("equipment attachment bone picking", () => {
  it("prefers hand bones over wrist fallbacks", () => {
    const root = new THREE.Group();
    const wrist = new THREE.Bone();
    wrist.name = "mixamorigLeftForeArm";
    const hand = new THREE.Bone();
    hand.name = "mixamorigLeftHand";
    root.add(wrist, hand);

    expect(findEquipmentAttachmentTarget(root, "leftHand")).toBe(hand);
  });

  it("uses wrist/lower-arm bones when generated rigs do not expose hands", () => {
    const root = new THREE.Group();
    const rightWrist = new THREE.Bone();
    rightWrist.name = "RightWrist";
    root.add(rightWrist);

    expect(findEquipmentAttachmentTarget(root, "rightHand")).toBe(rightWrist);
  });

  it("reserves back attachments for spine-like bones", () => {
    const root = new THREE.Group();
    const spine = new THREE.Bone();
    spine.name = "Spine2";
    root.add(spine);

    expect(findEquipmentAttachmentTarget(root, "back")).toBe(spine);
  });
});

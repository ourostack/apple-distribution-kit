const team = "TEAM123456";
const service = "SVC1234567";
const primary = "APP1234567";
const capability = `${service}_APPLE_ID_AUTH`;
const base = "https://developer.apple.com:443/services-account/v1";

function links(type: string, id: string) {
  return { self: `${base}/${type}/${id}` };
}
function navigation(type: string, id: string, name: string, paging = true) {
  return { ...(paging ? { meta: { paging: { total: 0, limit: 2147483647 } } } : {}),
    links: { self: `${base}/${type}/${id}/relationships/${name}`, related: `${base}/${type}/${id}/${name}` } };
}
function attributes(identifier: string, platform: string, name: string) {
  return { identifier, dateModified: "2026-01-02T03:04:05.000+00:00", entitlementGroupName: null,
    bundleType: "bundle", platform, wildcard: false, dateCreated: "2026-01-01T03:04:05.000+00:00",
    bundleIdCapabilitiesSettingOption: null, seedId: team, name, platformName: platform === "SERVICES" ? "Services" : "universal",
    deploymentDataNotice: null, responseId: "00000000-0000-4000-8000-000000000001" };
}
function input(key: string, name: string, displayOrder: number, values: string[]) {
  return { key, name, description: `${name} metadata`, allowedInstances: "SINGLE", minInstances: 1,
    displayOrder, maxLimit: 0, values: values.map(value => ({ value })) };
}

/** Sanitized structural transcription of the controller-supplied response, not its resource/account values. */
export function observedDeveloperService() {
  const inputs = [
    input("APPLE_ID_AUTH_WEB_RETURN_URL", "Return URL", 4, [
      "https://login.example.org/account/federation/oauth2",
      "https://login.example.org/tenant/federation/oauth2",
      "https://tenant.example.org/account/federation/oauth2",
      "https://tenant.example.org/tenant.example.org/federation/oauth2",
      "https://login.example.org/tenant.example.org/federation/oauth2"
    ]),
    input("APPLE_ID_AUTH_WEB_DOMAIN", "Web Domain", 3, ["tenant.example.org", "login.example.org"])
  ];
  const serviceCapability = { type: "bundleIdCapabilities", id: capability,
    attributes: { ownerType: "BUNDLE", settings: null, editable: true, inputs, enabled: true,
      responseId: "00000000-0000-4000-8000-000000000001" },
    relationships: {
      appConsentBundleId: { data: { type: "bundleIds", id: primary }, ...navigation("bundleIdCapabilities", capability, "appConsentBundleId", false) },
      appGroups: navigation("bundleIdCapabilities", capability, "appGroups"),
      associatedBundleIds: navigation("bundleIdCapabilities", capability, "associatedBundleIds"),
      bundleId: navigation("bundleIdCapabilities", capability, "bundleId", false),
      capability: { data: { type: "capabilities", id: "APPLE_ID_AUTH" }, ...navigation("bundleIdCapabilities", capability, "capability", false) },
      certificates: navigation("bundleIdCapabilities", capability, "certificates"),
      cloudContainers: navigation("bundleIdCapabilities", capability, "cloudContainers"),
      identityMerchantIds: navigation("bundleIdCapabilities", capability, "identityMerchantIds"),
      macBundleId: navigation("bundleIdCapabilities", capability, "macBundleId", false),
      mediaSharingProtocolIds: navigation("bundleIdCapabilities", capability, "mediaSharingProtocolIds"),
      merchantIds: navigation("bundleIdCapabilities", capability, "merchantIds"),
      parentBundleId: navigation("bundleIdCapabilities", capability, "parentBundleId", false),
      relatedAppConsentBundleIds: navigation("bundleIdCapabilities", capability, "relatedAppConsentBundleIds")
    }, links: links("bundleIdCapabilities", capability) };
  const descriptor = { type: "capabilities", id: "APPLE_ID_AUTH", attributes: {
    associations: [{ key: "APPLE_ID_AUTH_RELATED_APP_CONSENT_SERVICES", name: "Primary App ID", description: "Association metadata",
      allowedInstances: "MULTIPLE", minInstances: 1, displayOrder: 1, maxLimit: 5, visible: true,
      relationshipName: "appConsentBundleId", relationshipType: "bundleIds", supportedOperations: [] }],
    documentationURL: "https://developer.apple.com/documentation/xcode/configuring-sign-in-with-apple",
    supportsWildcard: false, editable: true, inputs: structuredClone(inputs), requestedCustomCapabilities: null,
    enabledByDefault: false, referenceType: null, description: "Capability display metadata", optional: true,
    associatedToRequestForms: false, hasExistingFeatureRequest: false, developmentOnly: false, displaySupportedSDKs: false,
    imageUrl: "/assets/example.svg", name: "Sign In with Apple", isPublic: true, optInRequired: false,
    canRequestFromPortal: false, capabilityType: "capability", distributionApprovalRequired: false,
    responseId: "00000000-0000-4000-8000-000000000001"
  }, links: links("capabilities", "APPLE_ID_AUTH") };
  const primaryBundle = { type: "bundleIds", id: primary,
    attributes: attributes("org.example.primary", "UNIVERSAL", "Example primary"),
    relationships: { bundleIdCapabilities: navigation("bundleIds", primary, "bundleIdCapabilities"),
      profiles: navigation("bundleIds", primary, "profiles") }, links: links("bundleIds", primary) };
  return { data: { type: "bundleIds", id: service, attributes: attributes("org.example.web", "SERVICES", "Existing web"),
    relationships: {
      bundleIdCapabilities: { ...navigation("bundleIds", service, "bundleIdCapabilities"),
        data: [{ type: "bundleIdCapabilities", id: capability }] },
      profiles: navigation("bundleIds", service, "profiles")
    }, links: links("bundleIds", service) },
    included: [serviceCapability, descriptor, primaryBundle],
    links: { self: `${base}/bundleIds/${service}?include=bundleIdCapabilities%2CbundleIdCapabilities.capability%2CbundleIdCapabilities.appConsentBundleId` } };
}

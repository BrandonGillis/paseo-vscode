import { useSettings, useTranslation } from "@getpaseo/plugin/client";
import {
  ExternalLink,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  type SettingsInputHandle,
} from "@getpaseo/plugin/client/ui";
import { useRef, useState } from "react";
import { Text, View } from "react-native";
import { EXTENSION_ID, settings } from "../shared/settings";
import { messages } from "./messages";

/** Settings, Plugins, VS Code: the extensions installed automatically, and remote access. */
export function SettingsScreen() {
  return (
    <View>
      <ExtensionsSettings />
      <RemoteAccessSettings />
    </View>
  );
}

/** Where the VS Code proxy listens and the URL the browser opens (see server/network.ts). */
function RemoteAccessSettings() {
  const { t } = useTranslation(messages);
  const state = useSettings(settings);
  const [draft, setDraft] = useState<{ listenHost?: string; port?: string; publicUrl?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  if (state.status !== "ready") return null;

  const values = state.values;
  const edit = (patch: typeof draft) => {
    setDraft((d) => ({ ...d, ...patch }));
    setError(null);
    setSaved(false);
  };
  const save = async () => {
    const port = draft.port === undefined ? values.port : Number(draft.port.trim() || "0");
    const next = {
      ...values,
      listenHost: draft.listenHost ?? values.listenHost,
      port,
      publicUrl: draft.publicUrl ?? values.publicUrl,
    };
    const parsed = settings.schema.safeParse(next);
    if (!parsed.success) return setError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    await state.save(parsed.data, state.revision);
    setDraft({});
    setSaved(true);
  };

  return (
    <SettingsSection title={t("settingsRemote")} info={<Text>{t("settingsRemoteInfo")}</Text>}>
      <SettingsCard>
        <SettingsInput
          label={t("settingsListenHost")}
          hint={t("settingsListenHostHint")}
          initialValue={values.listenHost}
          placeholder="127.0.0.1"
          disabled={state.saving}
          onChangeText={(listenHost) => edit({ listenHost })}
        />
        <SettingsInput
          label={t("settingsPort")}
          hint={t("settingsPortHint")}
          initialValue={String(values.port)}
          placeholder="0"
          disabled={state.saving}
          onChangeText={(port) => edit({ port })}
        />
        <SettingsInput
          label={t("settingsPublicUrl")}
          hint={saved ? t("settingsSaved") : t("settingsPublicUrlHint")}
          initialValue={values.publicUrl}
          placeholder="https://vscode.example.com"
          disabled={state.saving}
          error={error ?? state.saveError}
          onChangeText={(publicUrl) => edit({ publicUrl })}
        />
        <SettingsAction label="" actionLabel={t("settingsSave")} disabled={state.saving || Object.keys(draft).length === 0} onPress={() => void save()} />
      </SettingsCard>
    </SettingsSection>
  );
}

function ExtensionsSettings() {
  const { t } = useTranslation(messages);
  const state = useSettings(settings);
  const input = useRef<SettingsInputHandle>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (state.status !== "ready") {
    return (
      <SettingsSection title={t("settingsExtensions")}>
        <Text>{state.status === "loading" ? t("starting") : "error" in state ? state.error : ""}</Text>
      </SettingsSection>
    );
  }

  const list = state.values.extensions;
  const save = (extensions: string[]) => void state.save({ ...state.values, extensions }, state.revision);

  const add = () => {
    const id = draft.trim();
    if (!EXTENSION_ID.test(id)) return setError(t("settingsInvalidId"));
    if (list.some((e) => e.toLowerCase() === id.toLowerCase())) return setError(t("settingsDuplicate"));
    setError(null);
    setDraft("");
    input.current?.replaceText("");
    save([...list, id]);
  };

  return (
    <SettingsSection
      title={t("settingsExtensions")}
      info={
        <Text>
          {t("settingsExtensionsInfo")} <ExternalLink href="https://open-vsx.org">open-vsx.org</ExternalLink>
        </Text>
      }
    >
      <SettingsCard>
        {list.map((id) => (
          <SettingsAction
            key={id}
            label={id}
            actionLabel={t("settingsRemove")}
            disabled={state.saving}
            onPress={() => save(list.filter((e) => e !== id))}
          />
        ))}
        <SettingsInput
          ref={input}
          label={t("settingsAddLabel")}
          hint={t("settingsAddHint")}
          placeholder="bmewburn.vscode-intelephense-client"
          error={error ?? state.saveError}
          onChangeText={(text) => {
            setDraft(text);
            setError(null);
          }}
        />
        <SettingsAction label="" actionLabel={t("settingsAdd")} disabled={state.saving || !draft.trim()} onPress={add} />
      </SettingsCard>
    </SettingsSection>
  );
}

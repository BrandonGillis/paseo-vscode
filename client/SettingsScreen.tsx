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
import { Text } from "react-native";
import { EXTENSION_ID, settings } from "../shared/settings";
import { messages } from "./messages";

/** Settings, Plugins, VS Code: the extensions installed automatically. */
export function SettingsScreen() {
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

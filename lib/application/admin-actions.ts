import { z } from "zod";
import * as configuration from "@/lib/label-configuration-service";
import * as files from "@/lib/admin-file-service";
const noInput = z.object({});
export const adminActions = {
  "printing.configuration": { capability: "labels.read", description: "Read active managed printers/templates for a retained workflow", inputSchema: configuration.operatorLabelConfigurationInput, run: configuration.getOperatorLabelConfiguration },
  "printing.management": { capability: "labels.manage", description: "Read managed printer/template configuration", inputSchema: noInput, run: configuration.getManagedLabelConfiguration },
  "printing.printer.create": { capability: "labels.manage", description: "Create a managed printer destination", inputSchema: configuration.printerCreateInput, run: configuration.createPrinter },
  "printing.printer.update": { capability: "labels.manage", description: "Update a printer using its current version", inputSchema: configuration.printerUpdateInput, run: configuration.updatePrinter },
  "printing.printer.enabled": { capability: "labels.manage", description: "Enable/disable a managed printer", inputSchema: configuration.printerEnabledInput, run: configuration.setPrinterEnabled },
  "printing.template.create": { capability: "labels.manage", description: "Create a retained workflow template", inputSchema: configuration.templateCreateInput, run: configuration.createTemplate },
  "printing.template.update": { capability: "labels.manage", description: "Update a retained template using its current version", inputSchema: configuration.templateUpdateInput, run: configuration.updateTemplate },
  "printing.template.default": { capability: "labels.manage", description: "Choose the sole active default template for its purpose", inputSchema: configuration.templateDefaultInput, run: configuration.setDefaultTemplate },
  "printing.template.enabled": { capability: "labels.manage", description: "Enable/disable a retained template", inputSchema: configuration.templateEnabledInput, run: configuration.setTemplateEnabled },
  "files.list": { capability: "files.manage", description: "List entries inside the configured shared file root", inputSchema: files.adminFilesListInput, run: files.listAdminFiles },
  "files.download": { capability: "files.manage", description: "Download a bounded file as base64 with its fingerprint", inputSchema: files.adminFileDownloadInput, run: files.downloadAdminFile },
  "files.upload": { capability: "files.manage", description: "Upload files with durable intent IDs and explicit fingerprint-bound replacement", inputSchema: files.adminFilesUploadInput, run: files.uploadAdminFiles },
  "files.directory.create": { capability: "files.manage", description: "Create a directory inside the configured root", inputSchema: files.adminDirectoryCreateInput, run: files.createAdminDirectory },
  "files.move": { capability: "files.manage", description: "Move/rename the current fingerprint-bound shared entry", inputSchema: files.adminFileMoveInput, run: files.moveAdminFile },
  "files.delete": { capability: "files.manage", description: "Delete a fingerprint-bound entry; root and escaped links remain protected", inputSchema: files.adminFileDeleteInput, run: files.deleteAdminFile },
} as const;

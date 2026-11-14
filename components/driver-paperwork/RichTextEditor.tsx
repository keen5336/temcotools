"use client";

import { EditorContent, Node, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TEMPLATE_FIELDS, type RichNode } from "@/lib/driver-paperwork/templates";

const TemplateField = Node.create({
  name: "templateField", group: "inline", inline: true, atom: true,
  addAttributes() { return { name: { default: "route" } }; },
  parseHTML() { return [{ tag: "span[data-template-field]", getAttrs: element => ({ name: element.getAttribute("data-template-field") }) }]; },
  renderHTML({ node }) { return ["span", { "data-template-field": node.attrs.name, class: "template-field" }, `{{${node.attrs.name}}}`]; },
});

export default function RichTextEditor({ value, onChange, label, fields }: { value: RichNode; onChange: (value: RichNode) => void; label: string; fields: readonly string[] }) {
  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: false, blockquote: false, code: false, codeBlock: false, horizontalRule: false, link: false }), TemplateField],
    content: value, immediatelyRender: false,
    editorProps: { attributes: { role: "textbox", "aria-label": label, class: "min-h-44 p-4 outline-none" } },
    onUpdate: ({ editor }) => onChange(editor.getJSON() as RichNode),
  });
  const state = useEditorState({ editor, selector: ({ editor }) => ({ bold: editor?.isActive("bold"), italic: editor?.isActive("italic"), underline: editor?.isActive("underline"), bulletList: editor?.isActive("bulletList"), orderedList: editor?.isActive("orderedList") }) });
  return <div className="rounded-lg border border-base-300 overflow-hidden rich-paperwork-editor">
    <div className="flex flex-wrap items-center gap-1 border-b border-base-300 bg-base-200 p-2" role="toolbar" aria-label={`${label} formatting`}>
      <button className="btn btn-sm btn-ghost" type="button" aria-label="Bold" aria-pressed={state?.bold ?? false} onClick={() => editor?.chain().focus().toggleBold().run()}><b>B</b></button>
      <button className="btn btn-sm btn-ghost" type="button" aria-label="Italic" aria-pressed={state?.italic ?? false} onClick={() => editor?.chain().focus().toggleItalic().run()}><i>I</i></button>
      <button className="btn btn-sm btn-ghost" type="button" aria-label="Underline" aria-pressed={state?.underline ?? false} onClick={() => editor?.chain().focus().toggleUnderline().run()}><u>U</u></button>
      <button className="btn btn-sm btn-ghost" type="button" aria-pressed={state?.bulletList ?? false} onClick={() => editor?.chain().focus().toggleBulletList().run()}>Bullets</button>
      <button className="btn btn-sm btn-ghost" type="button" aria-pressed={state?.orderedList ?? false} onClick={() => editor?.chain().focus().toggleOrderedList().run()}>Numbered</button>
      <button className="btn btn-sm btn-ghost" type="button" onClick={() => editor?.chain().focus().undo().run()}>Undo</button>
      <button className="btn btn-sm btn-ghost" type="button" onClick={() => editor?.chain().focus().redo().run()}>Redo</button>
      <select className="select select-sm w-auto" aria-label="Insert template field" value="" onChange={event => { const name = event.target.value; if ((TEMPLATE_FIELDS as readonly string[]).includes(name)) editor?.chain().focus().insertContent({ type: "templateField", attrs: { name } }).run(); }}>
        <option value="">Insert field…</option>{fields.map(field => <option key={field} value={field}>{field}</option>)}
      </select>
    </div>
    <EditorContent editor={editor} />
    <style jsx global>{`.rich-paperwork-editor .tiptap ul{list-style:disc;padding-left:1.5rem}.rich-paperwork-editor .tiptap ol{list-style:decimal;padding-left:1.5rem}.rich-paperwork-editor .tiptap p{margin:.4rem 0}.rich-paperwork-editor .template-field{border-radius:4px;background:#dbeafe;color:#1e40af;padding:1px 4px;font:12px monospace}`}</style>
  </div>;
}

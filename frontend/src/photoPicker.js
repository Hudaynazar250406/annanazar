import './photoPicker.css'

export function installPhotoPicker(root) {
  function photoInput(form) {
    return form?.matches('form.uploader')
      ? form.querySelector('input[type="file"][name="file"]')
      : null
  }
  function focus(event) {
    const input = photoInput(event.target.form)
    if (input) input.required = false
  }
  function choose(event) {
    if (!(event.target instanceof Element)) return
    const button = event.target.closest('button.btn')
    const input = photoInput(button?.form)
    if (!input || button.disabled) return
    event.preventDefault()
    event.stopPropagation()
    input.required = false
    input.value = ''
    input.click()
  }
  function changed(event) {
    const input = event.target
    if (!(input instanceof HTMLInputElement) || input.type !== 'file' || !photoInput(input.form)) return
    if (input.files?.length) input.form.requestSubmit()
  }
  function submit(event) {
    const input = photoInput(event.target)
    if (!input || input.files?.length) return
    event.preventDefault()
    event.stopPropagation()
    input.required = false
    input.click()
  }
  root.addEventListener('focusin', focus, true)
  root.addEventListener('click', choose, true)
  root.addEventListener('change', changed, true)
  root.addEventListener('submit', submit, true)
  return () => {
    root.removeEventListener('focusin', focus, true)
    root.removeEventListener('click', choose, true)
    root.removeEventListener('change', changed, true)
    root.removeEventListener('submit', submit, true)
  }
}

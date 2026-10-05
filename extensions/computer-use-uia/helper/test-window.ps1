# Windows PowerShell 5.1 WinForms fixture. This process owns every control/window;
# no child processes, compiled code, file access, or save/confirmation dialogs.
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Name = 'testWindow'
$form.AccessibleName = 'Amira UIA test window'
$form.Text = 'Amira UIA test window'
$form.ClientSize = [System.Drawing.Size]::new(560, 400)
$form.StartPosition = 'CenterScreen'

$multilineLabel = New-Object System.Windows.Forms.Label
$multilineLabel.Name = 'multilineLabel'
$multilineLabel.AccessibleName = 'Multiline text'
$multilineLabel.Text = 'Multiline text'
$multilineLabel.SetBounds(16, 16, 520, 24)

$multiline = New-Object System.Windows.Forms.TextBox
$multiline.Name = 'multilineText'
$multiline.AccessibleName = 'Multiline text'
$multiline.Multiline = $true
$multiline.AcceptsReturn = $true
$multiline.ScrollBars = 'Vertical'
$multiline.TabIndex = 0
$multiline.SetBounds(16, 40, 520, 120)

$singlelineLabel = New-Object System.Windows.Forms.Label
$singlelineLabel.Name = 'singlelineLabel'
$singlelineLabel.AccessibleName = 'Single-line text'
$singlelineLabel.Text = 'Single-line text'
$singlelineLabel.SetBounds(16, 176, 520, 24)

$singleline = New-Object System.Windows.Forms.TextBox
$singleline.Name = 'singlelineText'
$singleline.AccessibleName = 'Single-line text'
$singleline.TabIndex = 1
$singleline.SetBounds(16, 200, 520, 28)

$button = New-Object System.Windows.Forms.Button
$button.Name = 'changeLabelButton'
$button.AccessibleName = 'Change label'
$button.Text = 'Change label'
$button.TabIndex = 2
$button.SetBounds(16, 244, 140, 36)

$status = New-Object System.Windows.Forms.Label
$status.Name = 'statusLabel'
$status.AccessibleName = 'Button not clicked'
$status.Text = 'Button not clicked'
$status.SetBounds(172, 250, 364, 28)
$button.Add_Click({
    $status.Text = 'Button clicked'
    $status.AccessibleName = 'Button clicked'
})

$checkbox = New-Object System.Windows.Forms.CheckBox
$checkbox.Name = 'testCheckbox'
$checkbox.AccessibleName = 'Enable option'
$checkbox.Text = 'Enable option'
$checkbox.TabIndex = 3
$checkbox.SetBounds(16, 296, 160, 32)

$listLabel = New-Object System.Windows.Forms.Label
$listLabel.Name = 'itemsLabel'
$listLabel.AccessibleName = 'Choose an item'
$listLabel.Text = 'Choose an item'
$listLabel.SetBounds(200, 292, 336, 24)

$list = New-Object System.Windows.Forms.ComboBox
$list.Name = 'testItems'
$list.AccessibleName = 'Choose an item'
$list.DropDownStyle = 'DropDownList'
$list.TabIndex = 4
$list.SetBounds(200, 320, 336, 28)
$list.Items.AddRange([object[]]@('Alpha', 'Beta', 'Gamma'))
$list.SelectedIndex = 0

$form.Controls.AddRange([System.Windows.Forms.Control[]]@(
    $multilineLabel, $multiline, $singlelineLabel, $singleline,
    $button, $status, $checkbox, $listLabel, $list
))
try { [System.Windows.Forms.Application]::Run($form) }
finally { $form.Dispose() }

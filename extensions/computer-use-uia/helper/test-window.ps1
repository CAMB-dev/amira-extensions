# Windows PowerShell 5.1 WinForms fixture. This process owns every control/window;
# no child processes, compiled code, file access, or save/confirmation dialogs.
param(
    [string] $Title = 'Amira UIA test window',
    [switch] $IgnoreClose,
    [int] $Left = [int]::MinValue,
    [int] $Top = [int]::MinValue
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Name = 'testWindow'
$form.AccessibleName = $Title
$form.Text = $Title
$form.ClientSize = [System.Drawing.Size]::new(560, 440)
$form.StartPosition = 'CenterScreen'
if ($Left -ne [int]::MinValue -and $Top -ne [int]::MinValue) {
    $form.StartPosition = 'Manual'
    $form.Location = [System.Drawing.Point]::new($Left, $Top)
}
if ($IgnoreClose) { $form.Add_FormClosing({ $_.Cancel = $true }) }
$form.KeyPreview = $true
$form.Add_KeyDown({
    if ($_.Control -and $_.KeyCode -eq [System.Windows.Forms.Keys]::M) {
        $form.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
        $_.Handled = $true
    }
})

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

$password = New-Object System.Windows.Forms.TextBox
$password.Name = 'passwordText'
$password.AccessibleName = 'Password'
$password.UseSystemPasswordChar = $true
$password.Text = 'fixture-secret-never-returned'
$password.TabIndex = 5
$password.SetBounds(16, 368, 520, 28)

$form.Controls.AddRange([System.Windows.Forms.Control[]]@(
    $multilineLabel, $multiline, $singlelineLabel, $singleline,
    $button, $status, $checkbox, $listLabel, $list, $password
))
try { [System.Windows.Forms.Application]::Run($form) }
finally { $form.Dispose() }
